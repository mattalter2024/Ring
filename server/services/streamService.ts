import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
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

const ALLOWED_DEV_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
])

export class StreamService {
  private server: http.Server | null = null
  private externalServer = false
  private port = 0
  private sessionSeq = 0
  private readonly authToken: string
  private readonly authTokenBuf: Buffer
  private readonly hlsRoot: string
  private readonly activeStreams = new Map<string, ActiveRingStream>()
  private readonly nvrHlsFeeds = new Map<
    string,
    { dirPath: string; playlistPath: string; streamUrl: string; startedAt: string }
  >()
  private readonly pendingNvrCameras = new Set<string>()
  private readonly wantedLiveViewers = new Map<string, { onEnded?: () => void }>()
  private readonly cleanupTimers = new Set<NodeJS.Timeout>()
  private readonly getRecordingsDir: () => string
  private readonly getAdditionalRecordingsDirs?: () => string[]
  private recordingPathResolver?: (id: string) => string | undefined
  private onStreamsChanged?: (sessions: LiveStreamSession[]) => void

  constructor(
    getRecordingsDir: () => string,
    getAdditionalRecordingsDirs?: () => string[],
  ) {
    this.getRecordingsDir = getRecordingsDir
    this.getAdditionalRecordingsDirs = getAdditionalRecordingsDirs
    this.authToken = crypto.randomBytes(24).toString('hex')
    this.authTokenBuf = Buffer.from(this.authToken, 'utf-8')
    this.hlsRoot = path.join(os.tmpdir(), 'ringwatch-hls')
    fs.mkdirSync(this.hlsRoot, { recursive: true, mode: 0o700 })
  }

  /**
   * Mount media routes (/media/<token>/...) directly onto the unified RingWatch backend HTTP server.
   * Uses same-origin relative URLs so live HLS & recorded MP4 playback work seamlessly over
   * localhost, LAN IPs, Tailscale, and reverse proxies.
   */
  attachToExternalServer(): void {
    this.externalServer = true
  }

  private tryRemoveSync(targetPath: string): void {
    try {
      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
    } catch {
      // On Windows, NTFS/FFmpeg/Defender may briefly hold a handle (ENOTEMPTY/EBUSY/EPERM).
      // Never crash the server process over temp HLS folder cleanup.
    }
  }

  private scheduleDirCleanup(targetPath: string, delayMs = 3000, retriesLeft = 4): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer)
      void fs.promises
        .rm(targetPath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 250,
        })
        .catch(() => {
          // Retry with backoff if Windows still holds an open file handle (ENOTEMPTY/EBUSY)
          if (retriesLeft > 0 && fs.existsSync(targetPath)) {
            this.scheduleDirCleanup(targetPath, Math.min(delayMs * 2, 20_000), retriesLeft - 1)
          }
        })
    }, delayMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    this.cleanupTimers.add(timer)
  }

  setRecordingPathResolver(resolver: (id: string) => string | undefined): void {
    this.recordingPathResolver = resolver
  }

  setOnStreamsChanged(cb: (sessions: LiveStreamSession[]) => void): void {
    this.onStreamsChanged = cb
  }

  private notifyStreamsChanged(): void {
    this.onStreamsChanged?.(this.listActiveSessions())
  }

  async startServer(): Promise<number> {
    if (this.externalServer) return this.port
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

  private isServerReady(): boolean {
    return this.externalServer || this.port > 0
  }

  private buildAuthenticatedBaseUrl(): string {
    if (this.externalServer) {
      return `/media/${this.authToken}`
    }
    return `http://127.0.0.1:${this.port}/media/${this.authToken}`
  }

  getRecordingPlaybackUrl(fileName: string): string {
    if (!this.isServerReady()) return ''
    return `${this.buildAuthenticatedBaseUrl()}/recordings/${encodeURIComponent(fileName)}`
  }

  getRecordingPlaybackUrlById(recordingId: string, fallbackFileName?: string): string {
    if (!this.isServerReady()) return ''
    if (this.recordingPathResolver) {
      return `${this.buildAuthenticatedBaseUrl()}/recording-id/${encodeURIComponent(recordingId)}`
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

  private isValidHostHeader(hostHeader: string | undefined): boolean {
    if (this.externalServer) return true
    if (!hostHeader) return true
    const lower = hostHeader.trim().toLowerCase()
    return (
      lower === `127.0.0.1:${this.port}` ||
      lower === `localhost:${this.port}` ||
      lower === `[::1]:${this.port}`
    )
  }

  private verifyAuthToken(candidate: string): boolean {
    const candidateBuf = Buffer.from(candidate, 'utf-8')
    if (candidateBuf.length !== this.authTokenBuf.length) {
      return false
    }
    return crypto.timingSafeEqual(candidateBuf, this.authTokenBuf)
  }

  handleMediaRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    this.handleHttpRequest(req, res)
  }

  private handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Vary', 'Origin')

    // Reject DNS rebinding attempts when running in standalone loopback mode
    if (!this.isValidHostHeader(req.headers.host)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    // Restrict CORS in standalone mode to local dev origins only (mounted mode is same-origin)
    const origin = req.headers.origin
    if (
      !this.externalServer &&
      (origin === 'null' || (origin && ALLOWED_DEV_ORIGINS.has(origin)))
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end('Method Not Allowed')
      return
    }

    const rawUrl = req.url ?? '/'
    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(rawUrl.split('?')[0])
    } catch {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }

    if (decodedPath.includes('\0')) {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }

    // Require per-session secret token in path prefix: /media/<token>/<route>
    if (!decodedPath.startsWith('/media/')) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    const afterMedia = decodedPath.slice('/media/'.length)
    const slashIdx = afterMedia.indexOf('/')
    if (slashIdx <= 0) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    const candidateToken = afterMedia.slice(0, slashIdx)
    if (!this.verifyAuthToken(candidateToken)) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }

    const cleanPath = afterMedia.slice(slashIdx)

    if (cleanPath.startsWith('/hls/')) {
      const relative = cleanPath.slice('/hls/'.length)
      const resolvedHlsRoot = path.resolve(this.hlsRoot)
      const fullPath = path.resolve(resolvedHlsRoot, relative)
      if (!this.isPathInsideRoots(fullPath, [resolvedHlsRoot])) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      const ext = path.extname(fullPath).toLowerCase()
      if (ext !== '.m3u8' && ext !== '.ts') {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      const stat = fs.statSync(fullPath)
      const contentType =
        ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control':
          ext === '.ts'
            ? 'private, max-age=10'
            : 'no-store, no-cache, must-revalidate',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const stream = fs.createReadStream(fullPath)
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(404)
        if (!res.writableEnded) res.end()
      })
      res.on('close', () => {
        if (!stream.destroyed) stream.destroy()
      })
      stream.pipe(res)
      return
    }

    if (cleanPath.startsWith('/recording-id/') && this.recordingPathResolver) {
      const recId = cleanPath.slice('/recording-id/'.length)
      const targetPath = this.recordingPathResolver(recId)
      if (
        !targetPath ||
        path.extname(targetPath).toLowerCase() !== '.mp4' ||
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
          path.extname(candidate).toLowerCase() === '.mp4' &&
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
    const isHead = req.method === 'HEAD'

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
        'Cache-Control': 'private, max-age=3600',
      })
      if (isHead) {
        res.end()
        return
      }
      const stream = fs.createReadStream(filePath, { start, end })
      stream.on('error', () => {
        if (!res.writableEnded) res.end()
      })
      res.on('close', () => {
        if (!stream.destroyed) stream.destroy()
      })
      stream.pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      })
      if (isHead) {
        res.end()
        return
      }
      const stream = fs.createReadStream(filePath)
      stream.on('error', () => {
        if (!res.writableEnded) res.end()
      })
      res.on('close', () => {
        if (!stream.destroyed) stream.destroy()
      })
      stream.pipe(res)
    }
  }

  listActiveSessions(): LiveStreamSession[] {
    return Array.from(this.activeStreams.values()).map((entry) => entry.session)
  }

  isStreaming(cameraId: string): boolean {
    return this.activeStreams.has(cameraId)
  }

  hasActiveFeed(cameraId: string): boolean {
    if (this.nvrHlsFeeds.has(cameraId)) return true
    const active = this.activeStreams.get(cameraId)
    return Boolean(active && active.dirPath)
  }

  getLatestHlsSegmentPath(cameraId: string, maxAgeMs?: number): string | null {
    const nowMs = Date.now()
    const isFresh = (mtimeMs: number) =>
      maxAgeMs === undefined || maxAgeMs <= 0 || nowMs - mtimeMs <= maxAgeMs

    const candidateDirs: string[] = []
    const nvrDir = this.nvrHlsFeeds.get(cameraId)?.dirPath
    if (nvrDir) candidateDirs.push(nvrDir)
    const activeDir = this.activeStreams.get(cameraId)?.dirPath
    if (activeDir && !candidateDirs.includes(activeDir)) {
      candidateDirs.push(activeDir)
    }

    for (const dirPath of candidateDirs) {
      if (!fs.existsSync(dirPath)) continue

      // Prefer the latest finalized segment listed in index.m3u8 (guaranteed complete via temp_file flag)
      const playlistPath = path.join(dirPath, 'index.m3u8')
      if (fs.existsSync(playlistPath)) {
        try {
          const lines = fs
            .readFileSync(playlistPath, 'utf-8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#') && line.toLowerCase().endsWith('.ts'))
          for (let i = lines.length - 1; i >= 0; i--) {
            const segPath = path.resolve(dirPath, path.basename(lines[i]))
            if (fs.existsSync(segPath)) {
              const stat = fs.statSync(segPath)
              if (stat.isFile() && stat.size >= 1024 && isFresh(stat.mtimeMs)) {
                return segPath
              }
            }
          }
        } catch {
          // Playlist mid-rename; fall through to directory scan
        }
      }

      // Fallback: pick newest non-temporary .ts file in directory
      try {
        const candidates = fs
          .readdirSync(dirPath)
          .filter((name) => {
            const lower = name.toLowerCase()
            return lower.endsWith('.ts') && !lower.endsWith('.tmp')
          })
          .map((name) => {
            const fullPath = path.join(dirPath, name)
            try {
              const stat = fs.statSync(fullPath)
              return stat.isFile() && stat.size >= 1024 && isFresh(stat.mtimeMs)
                ? { fullPath, name, mtimeMs: stat.mtimeMs }
                : null
            } catch {
              return null
            }
          })
          .filter((item): item is { fullPath: string; name: string; mtimeMs: number } => Boolean(item))
          .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))

        if (candidates.length > 0) {
          return candidates[0].fullPath
        }
      } catch {
        // Ignore transient directory errors
      }
    }

    return null
  }

  async waitForLatestHlsSegment(
    cameraId: string,
    timeoutMs = 3500,
    maxAgeMs?: number,
  ): Promise<string | null> {
    const immediate = this.getLatestHlsSegmentPath(cameraId, maxAgeMs)
    if (immediate) return immediate

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && this.hasActiveFeed(cameraId)) {
      await new Promise((r) => setTimeout(r, 250))
      const found = this.getLatestHlsSegmentPath(cameraId, maxAgeMs)
      if (found) return found
    }
    return this.getLatestHlsSegmentPath(cameraId, maxAgeMs)
  }

  clearPendingNvrCamera(cameraId: string): void {
    this.pendingNvrCameras.delete(cameraId)
  }

  async prepareNvrHlsOutput(cameraId: string): Promise<PreparedHlsOutput> {
    await this.startServer()

    this.pendingNvrCameras.add(cameraId)

    // Stop any standalone HLS live view on this camera so Ring only gets ONE WebRTC call,
    // while preserving viewer intent so Live View automatically attaches to the new NVR feed!
    const existing = this.activeStreams.get(cameraId)
    if (existing && !existing.nvrBacked) {
      this.wantedLiveViewers.set(cameraId, { onEnded: existing.onEnded })
      existing.stopFn()
    }

    const safeId = cameraId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sessionKey = `nvr_${safeId}_${Date.now()}_${++this.sessionSeq}`
    const dirPath = path.join(this.hlsRoot, sessionKey)
    this.tryRemoveSync(dirPath)
    fs.mkdirSync(dirPath, { recursive: true })

    const playlistPath = path.join(dirPath, 'index.m3u8')
    const ffmpegPlaylistPath = playlistPath.replace(/\\/g, '/')
    const ffmpegSegmentPattern = path.join(dirPath, 'seg_%05d.ts').replace(/\\/g, '/')

    return {
      safeId: sessionKey,
      dirPath,
      playlistPath,
      ffmpegPlaylistPath,
      ffmpegSegmentPattern,
      streamUrl: `${this.buildAuthenticatedBaseUrl()}/hls/${sessionKey}/index.m3u8`,
    }
  }

  private attachNvrViewerSession(
    cameraId: string,
    nvrFeed: { dirPath: string; playlistPath: string; streamUrl: string; startedAt: string },
    onEnded?: () => void,
  ): LiveStreamSession {
    const session: LiveStreamSession = {
      cameraId,
      mode: 'hls',
      streamUrl: nvrFeed.streamUrl,
      startedAt: nvrFeed.startedAt,
      audioEnabled: true,
    }
    this.wantedLiveViewers.set(cameraId, { onEnded })
    this.activeStreams.set(cameraId, {
      cameraId,
      session,
      dirPath: nvrFeed.dirPath,
      nvrBacked: true,
      onEnded,
      stopFn: () => {
        if (!this.activeStreams.has(cameraId)) return
        this.activeStreams.delete(cameraId)
        this.notifyStreamsChanged()
        onEnded?.()
      },
    })
    this.notifyStreamsChanged()
    return session
  }

  registerNvrHlsFeed(cameraId: string, prepared: PreparedHlsOutput): void {
    this.pendingNvrCameras.delete(cameraId)
    const feed = {
      dirPath: prepared.dirPath,
      playlistPath: prepared.playlistPath,
      streamUrl: prepared.streamUrl,
      startedAt: new Date().toISOString(),
    }
    this.nvrHlsFeeds.set(cameraId, feed)

    // Seamlessly re-attach live viewers after NVR session rotation without requiring user action
    const wanted = this.wantedLiveViewers.get(cameraId)
    if (wanted && !this.activeStreams.has(cameraId)) {
      void this.waitForHlsPlaylist(
        feed.playlistPath,
        () => this.nvrHlsFeeds.get(cameraId)?.dirPath === feed.dirPath,
        18000,
      ).then((ready) => {
        if (
          ready &&
          this.wantedLiveViewers.has(cameraId) &&
          !this.activeStreams.has(cameraId) &&
          this.nvrHlsFeeds.get(cameraId)?.dirPath === feed.dirPath
        ) {
          this.attachNvrViewerSession(cameraId, feed, wanted.onEnded)
        }
      })
    }
  }

  unregisterNvrHlsFeed(cameraId: string): void {
    const feed = this.nvrHlsFeeds.get(cameraId)
    this.nvrHlsFeeds.delete(cameraId)

    const active = this.activeStreams.get(cameraId)
    if (active?.nvrBacked) {
      this.activeStreams.delete(cameraId)
      this.notifyStreamsChanged()
      active.onEnded?.()
    }

    if (feed?.dirPath) {
      this.scheduleDirCleanup(feed.dirPath, 4000, 4)
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
      await new Promise((r) => setTimeout(r, 150))
    }
    return false
  }

  private async waitForPendingNvrFeed(
    cameraId: string,
    timeoutMs = 12000,
  ): Promise<{ dirPath: string; playlistPath: string; streamUrl: string; startedAt: string } | null> {
    const existing = this.nvrHlsFeeds.get(cameraId)
    if (existing) return existing
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && this.pendingNvrCameras.has(cameraId)) {
      const feed = this.nvrHlsFeeds.get(cameraId)
      if (feed) return feed
      await new Promise((r) => setTimeout(r, 150))
    }
    return this.nvrHlsFeeds.get(cameraId) ?? null
  }

  async startRingHlsStream(
    cameraId: string,
    camera: StreamableRingCamera,
    onEnded?: () => void,
  ): Promise<LiveStreamSession> {
    const existing = this.activeStreams.get(cameraId)
    if (existing) return existing.session

    await this.startServer()

    // If Continuous NVR is already streaming (or connecting/rotating) this camera,
    // wait for and reuse its live HLS feed instead of opening a conflicting second Ring WebRTC call!
    const nvrFeed =
      this.nvrHlsFeeds.get(cameraId) ??
      (this.pendingNvrCameras.has(cameraId)
        ? await this.waitForPendingNvrFeed(cameraId, 12000)
        : null)

    if (nvrFeed) {
      const ready = await this.waitForHlsPlaylist(
        nvrFeed.playlistPath,
        () => this.nvrHlsFeeds.get(cameraId)?.dirPath === nvrFeed.dirPath,
        18000,
      )
      if (ready && this.nvrHlsFeeds.get(cameraId)?.dirPath === nvrFeed.dirPath) {
        const already = this.activeStreams.get(cameraId)
        if (already) return already.session
        return this.attachNvrViewerSession(cameraId, nvrFeed, onEnded)
      }
    }

    const safeId = cameraId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sessionKey = `live_${safeId}_${Date.now()}_${++this.sessionSeq}`
    const dirPath = path.join(this.hlsRoot, sessionKey)
    this.tryRemoveSync(dirPath)
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
        '1',
        '-hls_list_size',
        '8',
        '-hls_delete_threshold',
        '4',
        '-hls_flags',
        'delete_segments+independent_segments+temp_file',
        '-hls_segment_filename',
        ffmpegSegmentPattern,
        ffmpegPlaylistPath,
      ],
    })

    const session: LiveStreamSession = {
      cameraId,
      mode: 'hls',
      streamUrl: `${this.buildAuthenticatedBaseUrl()}/hls/${sessionKey}/index.m3u8`,
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
      this.scheduleDirCleanup(dirPath, 4000, 4)
      this.notifyStreamsChanged()
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

    this.notifyStreamsChanged()
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
        if (!this.activeStreams.has(cameraId)) return
        this.activeStreams.delete(cameraId)
        this.notifyStreamsChanged()
      },
    })

    this.notifyStreamsChanged()
    return session
  }

  stopStream(cameraId: string): void {
    this.wantedLiveViewers.delete(cameraId)
    const active = this.activeStreams.get(cameraId)
    if (active) {
      active.stopFn()
    }
  }

  stopAll(): void {
    this.wantedLiveViewers.clear()
    this.pendingNvrCameras.clear()
    for (const id of Array.from(this.activeStreams.keys())) {
      this.stopStream(id)
    }
    this.nvrHlsFeeds.clear()
    for (const timer of this.cleanupTimers) {
      clearTimeout(timer)
    }
    this.cleanupTimers.clear()
    if (this.server) {
      this.server.close()
      this.server = null
      this.port = 0
    }
    this.tryRemoveSync(this.hlsRoot)
  }
}
