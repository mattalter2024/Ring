import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { LiveStreamSession } from '../../shared/types'

interface ActiveRingStream {
  cameraId: string
  session: LiveStreamSession
  dirPath: string
  nvrBacked?: boolean
  stopFn: () => void
  onEnded?: () => void
}

export interface PreparedHlsOutput {
  safeId: string
  dirPath: string
  playlistPath: string
  ffmpegPlaylistPath: string
  ffmpegSegmentPattern: string
  streamUrl: string
}

export interface StreamableRingCamera {
  id: number | string
  streamVideo(options: {
    video?: Array<string | number> | false
    audio?: Array<string | number>
    output: Array<string | number>
  }): Promise<{
    stop(): void
    onCallEnded: { subscribe(cb: () => void): unknown }
  }>
}

export class StreamService {
  private server: http.Server | null = null
  private port = 0
  private readonly hlsRoot: string
  private readonly activeStreams = new Map<string, ActiveRingStream>()
  private readonly nvrHlsFeeds = new Map<
    string,
    { dirPath: string; playlistPath: string; streamUrl: string; startedAt: string }
  >()
  private readonly getRecordingsDir: () => string
  private readonly getAdditionalRecordingsDirs?: () => string[]
  private recordingPathResolver?: (id: string) => string | undefined

  constructor(
    getRecordingsDir: () => string,
    getAdditionalRecordingsDirs?: () => string[],
  ) {
    this.getRecordingsDir = getRecordingsDir
    this.getAdditionalRecordingsDirs = getAdditionalRecordingsDirs
    this.hlsRoot = path.join(os.tmpdir(), 'ringwatch-hls')
    fs.mkdirSync(this.hlsRoot, { recursive: true })
  }

  setRecordingPathResolver(resolver: (id: string) => string | undefined): void {
    this.recordingPathResolver = resolver
  }

  async startServer(): Promise<number> {
    if (this.server && this.port > 0) return this.port

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res)
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.server = server
          resolve(this.port)
        } else {
          reject(new Error('Failed to bind local media server'))
        }
      })
    })
  }

  getRecordingPlaybackUrl(fileName: string): string {
    if (!this.port) return ''
    return `http://127.0.0.1:${this.port}/recordings/${encodeURIComponent(fileName)}`
  }

  getRecordingPlaybackUrlById(recordingId: string, fallbackFileName?: string): string {
    if (!this.port) return ''
    if (this.recordingPathResolver) {
      return `http://127.0.0.1:${this.port}/recording-id/${encodeURIComponent(recordingId)}`
    }
    return this.getRecordingPlaybackUrl(fallbackFileName ?? recordingId)
  }

  private getAllowedRecordingRoots(): string[] {
    const roots = new Set<string>()
    const primary = this.getRecordingsDir()
    if (primary) roots.add(path.resolve(primary))
    if (this.getAdditionalRecordingsDirs) {
      for (const dir of this.getAdditionalRecordingsDirs()) {
        if (dir) roots.add(path.resolve(dir))
      }
    }
    return Array.from(roots)
  }

  private isPathInsideRoots(fullPath: string, roots: string[]): boolean {
    const resolved = path.resolve(fullPath)
    return roots.some((root) => {
      const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`
      return resolved === root || resolved.startsWith(normalizedRoot)
    })
  }

  private handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const rawUrl = req.url ?? '/'
    const cleanPath = decodeURIComponent(rawUrl.split('?')[0])

    if (cleanPath.startsWith('/hls/')) {
      const relative = cleanPath.slice('/hls/'.length)
      const fullPath = path.resolve(this.hlsRoot, relative)
      if (!fullPath.startsWith(path.resolve(this.hlsRoot))) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      const ext = path.extname(fullPath).toLowerCase()
      const contentType =
        ext === '.m3u8'
          ? 'application/vnd.apple.mpegurl'
          : ext === '.ts'
            ? 'video/mp2t'
            : 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      })
      const stream = fs.createReadStream(fullPath)
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(404)
        res.end()
      })
      stream.pipe(res)
      return
    }

    if (cleanPath.startsWith('/recording-id/') && this.recordingPathResolver) {
      const recId = cleanPath.slice('/recording-id/'.length)
      const targetPath = this.recordingPathResolver(recId)
      if (
        !targetPath ||
        !fs.existsSync(targetPath) ||
        !fs.statSync(targetPath).isFile()
      ) {
        res.writeHead(404)
        res.end('Recording not found')
        return
      }
      this.serveRangeVideo(req, res, targetPath)
      return
    }

    if (cleanPath.startsWith('/recordings/')) {
      const relPart = cleanPath.slice('/recordings/'.length).replace(/^[/\\]+/, '')
      if (!relPart || relPart.includes('..')) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      const roots = this.getAllowedRecordingRoots()
      for (const root of roots) {
        const candidate = path.resolve(root, relPart)
        if (
          this.isPathInsideRoots(candidate, [root]) &&
          fs.existsSync(candidate) &&
          fs.statSync(candidate).isFile()
        ) {
          this.serveRangeVideo(req, res, candidate)
          return
        }
      }
      res.writeHead(404)
      res.end('Recording not found')
      return
    }

    res.writeHead(404)
    res.end('Not found')
  }

  private serveRangeVideo(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    filePath: string,
  ): void {
    const stat = fs.statSync(filePath)
    const fileSize = stat.size
    const range = req.headers.range

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const start = match && match[1] ? Number.parseInt(match[1], 10) : 0
      const end =
        match && match[2] ? Math.min(Number.parseInt(match[2], 10), fileSize - 1) : fileSize - 1

      if (start >= fileSize || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` })
        res.end()
        return
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
      })
      const stream = fs.createReadStream(filePath, { start, end })
      stream.on('error', () => res.end())
      stream.pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      })
      const stream = fs.createReadStream(filePath)
      stream.on('error', () => res.end())
      stream.pipe(res)
    }
  }

  listActiveSessions(): LiveStreamSession[] {
    return Array.from(this.activeStreams.values()).map((entry) => entry.session)
  }

  isStreaming(cameraId: string): boolean {
    return this.activeStreams.has(cameraId)
  }

  async prepareNvrHlsOutput(cameraId: string): Promise<PreparedHlsOutput> {
    await this.startServer()

    // Stop any standalone HLS live view on this camera so Ring only gets ONE WebRTC call
    const existing = this.activeStreams.get(cameraId)
    if (existing && !existing.nvrBacked) {
      existing.stopFn()
    }

    const safeId = cameraId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const dirPath = path.join(this.hlsRoot, `nvr_${safeId}`)
    fs.rmSync(dirPath, { recursive: true, force: true })
    fs.mkdirSync(dirPath, { recursive: true })

    const playlistPath = path.join(dirPath, 'index.m3u8')
    const ffmpegPlaylistPath = playlistPath.replace(/\\/g, '/')
    const ffmpegSegmentPattern = path.join(dirPath, 'seg_%05d.ts').replace(/\\/g, '/')

    return {
      safeId: `nvr_${safeId}`,
      dirPath,
      playlistPath,
      ffmpegPlaylistPath,
      ffmpegSegmentPattern,
      streamUrl: `http://127.0.0.1:${this.port}/hls/nvr_${safeId}/index.m3u8`,
    }
  }

  registerNvrHlsFeed(cameraId: string, prepared: PreparedHlsOutput): void {
    this.nvrHlsFeeds.set(cameraId, {
      dirPath: prepared.dirPath,
      playlistPath: prepared.playlistPath,
      streamUrl: prepared.streamUrl,
      startedAt: new Date().toISOString(),
    })
  }

  unregisterNvrHlsFeed(cameraId: string): void {
    const feed = this.nvrHlsFeeds.get(cameraId)
    this.nvrHlsFeeds.delete(cameraId)

    const active = this.activeStreams.get(cameraId)
    if (active?.nvrBacked) {
      this.activeStreams.delete(cameraId)
      active.onEnded?.()
    }

    if (feed?.dirPath) {
      setTimeout(() => {
        fs.rmSync(feed.dirPath, { recursive: true, force: true })
      }, 1500)
    }
  }

  private async waitForHlsPlaylist(
    playlistPath: string,
    isStillValid: () => boolean,
    timeoutMs = 18000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fs.existsSync(playlistPath)) {
        try {
          const manifest = fs.readFileSync(playlistPath, 'utf-8')
          if (manifest.includes('.ts')) {
            return true
          }
        } catch {
          // Playlist mid-rename; retry on next tick
        }
      }
      if (!isStillValid()) {
        return false
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  async startRingHlsStream(
    cameraId: string,
    camera: StreamableRingCamera,
    onEnded?: () => void,
  ): Promise<LiveStreamSession> {
    const existing = this.activeStreams.get(cameraId)
    if (existing) return existing.session

    await this.startServer()

    // If Continuous NVR is already streaming this camera, reuse its live HLS feed instantly (zero extra Ring call!)
    const nvrFeed = this.nvrHlsFeeds.get(cameraId)
    if (nvrFeed) {
      const ready = await this.waitForHlsPlaylist(
        nvrFeed.playlistPath,
        () => this.nvrHlsFeeds.has(cameraId),
        18000,
      )
      if (ready && this.nvrHlsFeeds.has(cameraId)) {
        const session: LiveStreamSession = {
          cameraId,
          mode: 'hls',
          streamUrl: nvrFeed.streamUrl,
          startedAt: nvrFeed.startedAt,
          audioEnabled: true,
        }
        this.activeStreams.set(cameraId, {
          cameraId,
          session,
          dirPath: nvrFeed.dirPath,
          nvrBacked: true,
          onEnded,
          stopFn: () => {
            if (!this.activeStreams.has(cameraId)) return
            this.activeStreams.delete(cameraId)
            onEnded?.()
          },
        })
        return session
      }
    }

    const safeId = cameraId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const dirPath = path.join(this.hlsRoot, safeId)
    fs.rmSync(dirPath, { recursive: true, force: true })
    fs.mkdirSync(dirPath, { recursive: true })

    const playlistPath = path.join(dirPath, 'index.m3u8')
    // Use forward slashes for FFmpeg HLS muxer on Windows so relative segment URIs stay clean
    const ffmpegPlaylistPath = playlistPath.replace(/\\/g, '/')
    const ffmpegSegmentPattern = path.join(dirPath, 'seg_%05d.ts').replace(/\\/g, '/')

    const call = await camera.streamVideo({
      video: ['-vcodec', 'copy'],
      audio: ['-acodec', 'aac', '-b:a', '96k'],
      output: [
        '-f',
        'hls',
        '-hls_time',
        '2',
        '-hls_list_size',
        '6',
        '-hls_flags',
        'delete_segments+append_list+temp_file',
        '-hls_segment_filename',
        ffmpegSegmentPattern,
        ffmpegPlaylistPath,
      ],
    })

    const session: LiveStreamSession = {
      cameraId,
      mode: 'hls',
      streamUrl: `http://127.0.0.1:${this.port}/hls/${safeId}/index.m3u8`,
      startedAt: new Date().toISOString(),
      audioEnabled: true,
    }

    const cleanup = () => {
      if (!this.activeStreams.has(cameraId)) return
      this.activeStreams.delete(cameraId)
      try {
        call.stop()
      } catch {
        // Already stopped
      }
      setTimeout(() => {
        fs.rmSync(dirPath, { recursive: true, force: true })
      }, 1500)
      onEnded?.()
    }

    this.activeStreams.set(cameraId, {
      cameraId,
      session,
      dirPath,
      onEnded,
      stopFn: cleanup,
    })

    call.onCallEnded.subscribe(() => {
      cleanup()
    })

    // Wait up to 18s for FFmpeg to produce an HLS manifest containing at least one .ts segment
    const ready = await this.waitForHlsPlaylist(
      playlistPath,
      () => this.activeStreams.has(cameraId),
      18000,
    )

    if (!ready) {
      const stillActive = this.activeStreams.has(cameraId)
      cleanup()
      throw new Error(
        stillActive
          ? 'Timed out waiting for Ring video frames (18s). Check camera signal or Ring Live View settings.'
          : 'Live stream ended before video frames were received from Ring',
      )
    }

    return session
  }

  startDemoStream(cameraId: string): LiveStreamSession {
    const existing = this.activeStreams.get(cameraId)
    if (existing) return existing.session

    const session: LiveStreamSession = {
      cameraId,
      mode: 'demo',
      streamUrl: `demo://${cameraId}`,
      startedAt: new Date().toISOString(),
      audioEnabled: false,
    }

    this.activeStreams.set(cameraId, {
      cameraId,
      session,
      dirPath: '',
      stopFn: () => {
        this.activeStreams.delete(cameraId)
      },
    })

    return session
  }

  stopStream(cameraId: string): void {
    const active = this.activeStreams.get(cameraId)
    if (active) {
      active.stopFn()
    }
  }

  stopAll(): void {
    for (const id of Array.from(this.activeStreams.keys())) {
      this.stopStream(id)
    }
    this.nvrHlsFeeds.clear()
    if (this.server) {
      this.server.close()
      this.server = null
      this.port = 0
    }
    fs.rmSync(this.hlsRoot, { recursive: true, force: true })
  }
}
