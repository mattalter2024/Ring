import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { LiveStreamSession } from '../../shared/types'

interface ActiveRingStream {
  cameraId: string
  session: LiveStreamSession
  dirPath: string
  stopFn: () => void
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
  private readonly getRecordingsDir: () => string

  constructor(getRecordingsDir: () => string) {
    this.getRecordingsDir = getRecordingsDir
    this.hlsRoot = path.join(os.tmpdir(), 'ringwatch-hls')
    fs.mkdirSync(this.hlsRoot, { recursive: true })
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

    if (cleanPath.startsWith('/recordings/')) {
      const fileName = path.basename(cleanPath.slice('/recordings/'.length))
      const recDir = this.getRecordingsDir()
      const fullPath = path.resolve(recDir, fileName)
      if (
        !fullPath.startsWith(path.resolve(recDir)) ||
        !fs.existsSync(fullPath) ||
        !fs.statSync(fullPath).isFile()
      ) {
        res.writeHead(404)
        res.end('Recording not found')
        return
      }
      this.serveRangeVideo(req, res, fullPath)
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

  async startRingHlsStream(
    cameraId: string,
    camera: StreamableRingCamera,
    onEnded?: () => void,
  ): Promise<LiveStreamSession> {
    const existing = this.activeStreams.get(cameraId)
    if (existing) return existing.session

    await this.startServer()

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
      stopFn: cleanup,
    })

    call.onCallEnded.subscribe(() => {
      cleanup()
    })

    // Wait up to 18s for FFmpeg to produce an HLS manifest containing at least one .ts segment
    const deadline = Date.now() + 18000
    let ready = false
    while (Date.now() < deadline) {
      if (fs.existsSync(playlistPath)) {
        try {
          const manifest = fs.readFileSync(playlistPath, 'utf-8')
          if (manifest.includes('.ts')) {
            ready = true
            break
          }
        } catch {
          // Playlist mid-rename; retry on next tick
        }
      }
      if (!this.activeStreams.has(cameraId)) {
        throw new Error('Live stream ended before video frames were received from Ring')
      }
      await new Promise((r) => setTimeout(r, 250))
    }

    if (!ready) {
      cleanup()
      throw new Error(
        'Timed out waiting for Ring video frames (18s). Check camera signal or Ring Live View settings.',
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
    if (this.server) {
      this.server.close()
      this.server = null
      this.port = 0
    }
    fs.rmSync(this.hlsRoot, { recursive: true, force: true })
  }
}
