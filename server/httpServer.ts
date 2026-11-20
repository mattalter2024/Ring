import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type {
  AppMode,
  AppSettingsPatch,
  AuthStatus,
  PackageDetectionRecord,
  RingWatchBootstrap,
} from '../shared/types'
import { ConfigStore } from './services/configStore'
import { StreamService } from './services/streamService'
import { RecordingService } from './services/recordingService'
import { NotificationService } from './services/notificationService'
import { AiPackageService } from './services/aiPackageService'
import { RingService } from './services/ringService'
import { BackendLogger } from './services/logger'
import {
  FileKeyCryptoAdapter,
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} from './services/secretCrypto'

const SESSION_COOKIE_NAME = 'ringwatch_session'
const MAX_JSON_BODY_BYTES = 1024 * 1024 // 1 MB

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function assertSafeDrivePath(drivePath: unknown): string {
  if (typeof drivePath !== 'string') {
    throw new Error('Invalid drive path')
  }
  const trimmed = drivePath.trim()
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error('Invalid drive path')
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error('Drive path must be an absolute path')
  }
  const segments = trimmed.split(/[\\/]+/)
  if (segments.includes('..')) {
    throw new Error('Drive path cannot contain parent directory traversal')
  }
  return trimmed
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!cookieHeader) return out
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    try {
      out[key] = decodeURIComponent(val)
    } catch {
      out[key] = val
    }
  }
  return out
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_JSON_BODY_BYTES) {
        reject(new Error('Request payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        )
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export interface RingWatchServerOptions {
  dataDir: string
  defaultRecordingsDir: string
  webDistDir: string
  demoAssetsDir: string
  host?: string
  port?: number
  envAuthPassword?: string
  logger?: BackendLogger
  controlToken?: string
  onRequestShutdown?: () => void
}

export class RingWatchServer {
  readonly configStore: ConfigStore
  readonly streamService: StreamService
  readonly recordingService: RecordingService
  readonly notificationService: NotificationService
  readonly aiPackageService: AiPackageService
  readonly ringService: RingService
  readonly logger: BackendLogger

  private readonly cryptoAdapter: FileKeyCryptoAdapter
  private readonly sessionSigningKey: Buffer
  private readonly webDistDir: string
  private readonly host: string
  private readonly requestedPort: number
  private readonly envAuthPassword: string | null
  private readonly controlTokenBuf: Buffer | null
  private readonly onRequestShutdown?: () => void

  private server: http.Server | null = null
  private boundPort = 0
  private readonly sseClients = new Set<http.ServerResponse>()
  private sseHeartbeatTimer: NodeJS.Timeout | null = null
  private rescanTimer: NodeJS.Timeout | null = null

  constructor(options: RingWatchServerOptions) {
    fs.mkdirSync(options.dataDir, { recursive: true })
    this.webDistDir = path.resolve(options.webDistDir)
    this.host = options.host ?? '0.0.0.0'
    this.requestedPort = options.port ?? 3456
    this.envAuthPassword = options.envAuthPassword?.trim() || null
    this.logger =
      options.logger ??
      new BackendLogger({
        logsDir: path.join(options.dataDir, 'logs'),
        debugEnabled: false,
      })
    this.controlTokenBuf = options.controlToken?.trim()
      ? Buffer.from(options.controlToken.trim(), 'utf-8')
      : null
    this.onRequestShutdown = options.onRequestShutdown

    this.cryptoAdapter = new FileKeyCryptoAdapter(options.dataDir)
    this.sessionSigningKey = this.cryptoAdapter.getSessionSigningKey()

    this.configStore = new ConfigStore(
      options.dataDir,
      options.defaultRecordingsDir,
      this.cryptoAdapter,
    )

    this.streamService = new StreamService(
      () => this.configStore.getPublicSettings().recordingsDir,
      () => this.recordingService?.getAllStorageRoots() ?? [],
    )
    this.streamService.attachToExternalServer()
    this.streamService.setOnStreamsChanged((sessions) => {
      this.broadcast('streams-updated', sessions)
    })

    this.recordingService = new RecordingService(
      options.dataDir,
      this.configStore,
      this.streamService,
    )
    this.streamService.setRecordingPathResolver(
      (id) => this.recordingService.getRecordingById(id)?.filePath,
    )

    this.notificationService = new NotificationService((channel, payload) => {
      this.broadcast(channel, payload)
    })

    this.aiPackageService = new AiPackageService({
      userDataDir: options.dataDir,
      configStore: this.configStore,
      notifications: this.notificationService,
      onDetection: (record) => {
        this.broadcast('package-detection', record)
      },
      onSecurityEvent: (ev) => {
        this.ringService.recordExternalEvent(ev)
        if (ev.deviceId) {
          void this.ringService.autoCaptureIfEnabled(ev.deviceId, 'package')
        }
      },
    })

    this.ringService = new RingService({
      userDataDir: options.dataDir,
      configStore: this.configStore,
      streamService: this.streamService,
      recordingService: this.recordingService,
      aiPackageService: this.aiPackageService,
      notifications: this.notificationService,
      demoAssetsDir: options.demoAssetsDir,
      callbacks: {
        onConnectionChanged: (status) => this.broadcast('connection-changed', status),
        onSettingsUpdated: (settings) => this.broadcast('settings-updated', settings),
        onLocationsUpdated: (locs) => this.broadcast('locations-updated', locs),
        onCamerasUpdated: (cams) => this.broadcast('cameras-updated', cams),
        onSensorsUpdated: (sens) => this.broadcast('sensors-updated', sens),
        onSecurityEvent: (ev) => this.broadcast('security-event', ev),
        onEventsUpdated: (evs) => this.broadcast('events-updated', evs),
        onNvrStatusUpdated: (nvr) => this.broadcast('nvr-status-updated', nvr),
        onRecordingsUpdated: (recs) => this.broadcast('recordings-updated', recs),
        onStorageStatsUpdated: (stats) => this.broadcast('storage-stats-updated', stats),
      },
    })
  }

  private getActivePasswordSecret(): string | null {
    if (this.envAuthPassword) return this.envAuthPassword
    return this.configStore.getAuthPasswordHash() ?? null
  }

  isAuthEnabled(): boolean {
    return Boolean(this.getActivePasswordSecret())
  }

  private isAuthenticated(req: http.IncomingMessage): boolean {
    if (!this.isAuthEnabled()) return true
    const cookies = parseCookies(req.headers.cookie)
    return verifySessionToken(cookies[SESSION_COOKIE_NAME], this.sessionSigningKey)
  }

  getAuthStatus(req: http.IncomingMessage): AuthStatus {
    const authEnabled = this.isAuthEnabled()
    return {
      authEnabled,
      authenticated: authEnabled ? this.isAuthenticated(req) : true,
      managedByEnv: Boolean(this.envAuthPassword),
    }
  }

  private buildSessionCookieHeader(token: string, maxAgeSeconds: number): string {
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
  }

  broadcast(channel: string, payload: unknown): void {
    if (this.sseClients.size === 0) return
    const frame = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of Array.from(this.sseClients)) {
      try {
        if (!client.writableEnded && !client.destroyed) {
          client.write(frame)
        } else {
          this.sseClients.delete(client)
        }
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  async start(): Promise<{ port: number; host: string }> {
    if (this.server && this.boundPort > 0) {
      return { port: this.boundPort, host: this.host }
    }

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      server.on('error', reject)
      server.listen(this.requestedPort, this.host, () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this.boundPort = addr.port
          this.server = server
          resolve()
        } else {
          reject(new Error('Failed to start RingWatch HTTP server'))
        }
      })
    })

    this.sseHeartbeatTimer = setInterval(() => {
      for (const client of Array.from(this.sseClients)) {
        try {
          if (!client.writableEnded && !client.destroyed) {
            client.write(': ping\n\n')
          } else {
            this.sseClients.delete(client)
          }
        } catch {
          this.sseClients.delete(client)
        }
      }
    }, 20_000)
    if (typeof this.sseHeartbeatTimer.unref === 'function') {
      this.sseHeartbeatTimer.unref()
    }

    // Initialize Ring, NVR, AI, and storage rescan in background so HTTP server responds immediately
    void this.ringService.initialize().catch((err) => {
      console.warn('[RingWatch Server] Initialization warning:', err)
    })
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      try {
        const res = this.recordingService.rescanDirectory()
        this.broadcast('recordings-updated', res.recordings)
        this.broadcast('storage-stats-updated', res.stats)
      } catch {
        // Ignore background rescan errors
      }
    }, 2000)
    if (typeof this.rescanTimer.unref === 'function') {
      this.rescanTimer.unref()
    }

    return { port: this.boundPort, host: this.host }
  }

  async stop(): Promise<void> {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer)
      this.rescanTimer = null
    }
    if (this.sseHeartbeatTimer) {
      clearInterval(this.sseHeartbeatTimer)
      this.sseHeartbeatTimer = null
    }
    for (const client of Array.from(this.sseClients)) {
      try {
        client.end()
      } catch {
        // ignore
      }
    }
    this.sseClients.clear()

    this.ringService.shutdown()
    this.recordingService.flushIndexSync()
    this.streamService.stopAll()

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve())
      })
      this.server = null
      this.boundPort = 0
    }
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: unknown,
    extraHeaders?: Record<string, string>,
  ): void {
    const body = JSON.stringify(payload)
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    })
    res.end(body)
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')

    const rawUrl = req.url ?? '/'
    const qIdx = rawUrl.indexOf('?')
    const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl

    let pathname: string
    try {
      pathname = decodeURIComponent(rawPath)
    } catch {
      this.sendJson(res, 400, { error: 'Bad Request' })
      return
    }
    if (pathname.includes('\0')) {
      this.sendJson(res, 400, { error: 'Bad Request' })
      return
    }

    // 1. Authenticated media routes (/media/<token>/hls/... & /media/<token>/recording-id/...)
    if (pathname.startsWith('/media/')) {
      if (this.isAuthEnabled() && !this.isAuthenticated(req)) {
        // Media already requires a 192-bit per-session secret token in path;
        // enforce session cookie too when auth is enabled for defense in depth.
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
      this.streamService.handleMediaRequest(req, res)
      return
    }

    // 2. Backend REST API & SSE routes
    if (pathname.startsWith('/api/')) {
      try {
        await this.handleApiRequest(req, res, pathname)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!res.headersSent) {
          this.sendJson(res, 400, { error: message })
        }
      }
      return
    }

    // 3. Static web frontend assets + SPA fallback
    this.serveStaticFrontend(req, res, pathname)
  }

  private async handleApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()

    // Public endpoints (no auth required)
    if (method === 'GET' && pathname === '/api/health') {
      this.sendJson(res, 200, {
        ok: true,
        mode: this.ringService.getConnection().mode,
        nvrActive: this.ringService.getNvrStatus().active,
        authEnabled: this.isAuthEnabled(),
        uptimeSeconds: Math.round(process.uptime()),
        logsDir: this.logger.logsDir,
        debugEnabled: this.logger.debugEnabled,
      })
      return
    }

    // Internal localhost-only graceful shutdown hook for the Windows Service wrapper
    if (method === 'POST' && pathname === '/api/internal/shutdown') {
      const headerToken = String(req.headers['x-ringwatch-control'] ?? '').trim()
      if (!this.controlTokenBuf || !headerToken) {
        this.sendJson(res, 403, { error: 'Forbidden' })
        return
      }
      const candBuf = Buffer.from(headerToken, 'utf-8')
      if (
        candBuf.length !== this.controlTokenBuf.length ||
        !crypto.timingSafeEqual(candBuf, this.controlTokenBuf)
      ) {
        this.sendJson(res, 403, { error: 'Forbidden' })
        return
      }
      this.sendJson(res, 200, { ok: true, shuttingDown: true })
      setTimeout(() => {
        this.onRequestShutdown?.()
      }, 50)
      return
    }

    if (method === 'GET' && pathname === '/api/auth/status') {
      this.sendJson(res, 200, this.getAuthStatus(req))
      return
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req)
      const password = typeof body.password === 'string' ? body.password : ''
      const expected = this.getActivePasswordSecret()
      if (!expected) {
        this.sendJson(res, 200, { ok: true })
        return
      }
      if (!verifyPassword(password, expected)) {
        this.sendJson(res, 401, { ok: false, error: 'Incorrect password.' })
        return
      }
      const token = createSessionToken(this.sessionSigningKey)
      this.sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': this.buildSessionCookieHeader(token, 7 * 24 * 60 * 60) },
      )
      return
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      this.sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': this.buildSessionCookieHeader('', 0) },
      )
      return
    }

    // Enforce optional login gate for all protected API routes
    if (!this.isAuthenticated(req)) {
      this.sendJson(res, 401, { error: 'Authentication required' })
      return
    }

    // Troubleshooting logs API
    if (method === 'GET' && pathname === '/api/logs') {
      this.sendJson(res, 200, {
        logsDir: this.logger.logsDir,
        logFilePath: this.logger.logFilePath,
        debugEnabled: this.logger.debugEnabled,
        lines: this.logger.readRecentLines(400),
      })
      return
    }

    if (method === 'GET' && pathname === '/api/logs/download') {
      const report = this.logger.buildTroubleshootingReport({
        connection: this.ringService.getConnection(),
        nvrStatus: this.ringService.getNvrStatus(),
        storageStats: this.recordingService.getStorageStats(),
        settings: this.configStore.getPublicSettings(),
        recentPackageDetections: this.aiPackageService
          .listDetections()
          .slice(0, 15)
          .map(({ snapshotDataUrl: _drop, ...rest }) => rest),
      })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const buf = Buffer.from(report, 'utf-8')
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="ringwatch-troubleshooting-${stamp}.log"`,
        'Cache-Control': 'no-store',
      })
      res.end(buf)
      return
    }

    // Update or remove optional login password from Settings UI
    if (method === 'POST' && pathname === '/api/auth/password') {
      if (this.envAuthPassword) {
        this.sendJson(res, 400, {
          ok: false,
          authEnabled: true,
          error:
            'Password is managed by the RINGWATCH_AUTH_PASSWORD environment variable.',
        })
        return
      }
      const body = await readJsonBody(req)
      const currentPassword =
        typeof body.currentPassword === 'string' ? body.currentPassword : ''
      const newPassword =
        typeof body.newPassword === 'string' ? body.newPassword.trim() : ''

      const existingHash = this.configStore.getAuthPasswordHash()
      if (existingHash && !verifyPassword(currentPassword, existingHash)) {
        this.sendJson(res, 403, {
          ok: false,
          authEnabled: true,
          error: 'Current password is incorrect.',
        })
        return
      }

      if (!newPassword) {
        this.configStore.setAuthPasswordHash(null)
        this.sendJson(
          res,
          200,
          { ok: true, authEnabled: false },
          { 'Set-Cookie': this.buildSessionCookieHeader('', 0) },
        )
        return
      }

      if (newPassword.length < 4) {
        this.sendJson(res, 400, {
          ok: false,
          authEnabled: Boolean(existingHash),
          error: 'Password must be at least 4 characters.',
        })
        return
      }

      this.configStore.setAuthPasswordHash(hashPassword(newPassword))
      const token = createSessionToken(this.sessionSigningKey)
      this.sendJson(
        res,
        200,
        { ok: true, authEnabled: true },
        { 'Set-Cookie': this.buildSessionCookieHeader(token, 7 * 24 * 60 * 60) },
      )
      return
    }

    // Real-time Server-Sent Events stream
    if (method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('event: connected\ndata: {"ok":true}\n\n')
      this.sseClients.add(res)
      req.on('close', () => {
        this.sseClients.delete(res)
      })
      return
    }

    // Bootstrap payload
    if (method === 'GET' && pathname === '/api/bootstrap') {
      const payload: RingWatchBootstrap = {
        connection: this.ringService.getConnection(),
        settings: this.configStore.getPublicSettings(),
        storageStats: this.recordingService.getStorageStats(),
        nvrStatus: this.ringService.getNvrStatus(),
        locations: this.ringService.getLocations(),
        cameras: this.ringService.getCameras(),
        sensors: this.ringService.getSensors(),
        events: this.ringService.getEvents(),
        recordings: this.recordingService.listRecordings(),
        packageDetections: this.aiPackageService.listDetections(),
        activeStreams: this.streamService.listActiveSessions(),
        authStatus: this.getAuthStatus(req),
      }
      this.sendJson(res, 200, payload)
      return
    }

    // Connection & Ring Account
    if (method === 'POST' && pathname === '/api/connection/token') {
      const body = await readJsonBody(req)
      const token = typeof body.refreshToken === 'string' ? body.refreshToken : ''
      this.sendJson(res, 200, await this.ringService.connectWithToken(token))
      return
    }
    if (method === 'POST' && pathname === '/api/connection/login') {
      const body = await readJsonBody(req)
      this.sendJson(
        res,
        200,
        await this.ringService.loginWithCredentials({
          email: String(body.email ?? ''),
          password: String(body.password ?? ''),
          twoFactorCode:
            typeof body.twoFactorCode === 'string' ? body.twoFactorCode : undefined,
        }),
      )
      return
    }
    if (method === 'POST' && pathname === '/api/connection/disconnect') {
      this.sendJson(res, 200, await this.ringService.disconnectRing())
      return
    }
    if (method === 'POST' && pathname === '/api/connection/mode') {
      const body = await readJsonBody(req)
      const mode = body.mode === 'live' ? 'live' : ('demo' as AppMode)
      this.sendJson(res, 200, await this.ringService.switchMode(mode))
      return
    }
    if (method === 'POST' && pathname === '/api/connection/refresh') {
      this.sendJson(res, 200, await this.ringService.refreshDevices())
      return
    }

    // Camera controls & live streams
    const camMatch = /^\/api\/cameras\/([^/]+)\/(.+)$/.exec(pathname)
    if (camMatch) {
      const cameraId = camMatch[1]
      const action = camMatch[2]
      if (method === 'POST' && action === 'stream/start') {
        this.sendJson(res, 200, await this.ringService.startLiveStream(cameraId))
        return
      }
      if (method === 'POST' && action === 'stream/stop') {
        this.ringService.stopLiveStream(cameraId)
        this.sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && action === 'snapshot') {
        this.sendJson(res, 200, await this.ringService.captureSnapshot(cameraId))
        return
      }
      if (method === 'POST' && action === 'light') {
        const body = await readJsonBody(req)
        this.sendJson(
          res,
          200,
          await this.ringService.toggleCameraLight(cameraId, Boolean(body.on)),
        )
        return
      }
      if (method === 'POST' && action === 'siren') {
        const body = await readJsonBody(req)
        this.sendJson(
          res,
          200,
          await this.ringService.toggleCameraSiren(cameraId, Boolean(body.on)),
        )
        return
      }
      if (method === 'GET' && action === 'cloud-recordings') {
        this.sendJson(res, 200, await this.ringService.listCloudRecordings(cameraId))
        return
      }
      const cloudDlMatch = /^cloud-recordings\/([^/]+)\/download$/.exec(action)
      if (method === 'POST' && cloudDlMatch) {
        this.sendJson(
          res,
          200,
          await this.ringService.downloadCloudRecording(cameraId, cloudDlMatch[1]),
        )
        return
      }
    }

    // Alarm mode
    const locAlarmMatch = /^\/api\/locations\/([^/]+)\/alarm$/.exec(pathname)
    if (method === 'POST' && locAlarmMatch) {
      const body = await readJsonBody(req)
      const mode =
        body.mode === 'some' || body.mode === 'all' ? body.mode : 'none'
      this.sendJson(
        res,
        200,
        await this.ringService.setAlarmMode(locAlarmMatch[1], mode),
      )
      return
    }

    // NVR continuous recording
    if (method === 'GET' && pathname === '/api/nvr/status') {
      this.sendJson(res, 200, this.ringService.getNvrStatus())
      return
    }
    if (method === 'POST' && pathname === '/api/nvr/start') {
      const body = await readJsonBody(req)
      const cameraIds = Array.isArray(body.cameraIds)
        ? body.cameraIds.filter((x): x is string => typeof x === 'string')
        : undefined
      this.sendJson(
        res,
        200,
        await this.ringService.startAllCameraRecording(cameraIds),
      )
      return
    }
    if (method === 'POST' && pathname === '/api/nvr/stop') {
      this.sendJson(res, 200, await this.ringService.stopAllCameraRecording())
      return
    }
    const nvrCamMatch = /^\/api\/nvr\/camera\/([^/]+)$/.exec(pathname)
    if (method === 'POST' && nvrCamMatch) {
      const body = await readJsonBody(req)
      this.sendJson(
        res,
        200,
        await this.ringService.toggleCameraContinuousRecording(
          nvrCamMatch[1],
          Boolean(body.enable),
        ),
      )
      return
    }
    if (method === 'POST' && pathname === '/api/timeline/sync-cloud') {
      this.sendJson(res, 200, await this.ringService.syncCloudEventsToTimeline())
      return
    }

    // Recordings & local vault
    if (method === 'GET' && pathname === '/api/recordings') {
      this.sendJson(res, 200, this.recordingService.listRecordings())
      return
    }
    if (method === 'POST' && pathname === '/api/recordings/capture') {
      const body = await readJsonBody(req)
      this.sendJson(
        res,
        200,
        await this.ringService.captureRecording({
          cameraId: String(body.cameraId ?? ''),
          durationSeconds: Number(body.durationSeconds ?? 30),
          trigger:
            typeof body.trigger === 'string'
              ? (body.trigger as 'manual' | 'motion' | 'ding' | 'package')
              : 'manual',
        }),
      )
      return
    }
    if (method === 'POST' && pathname === '/api/recordings/open-folder') {
      const rootDir = this.configStore.getPublicSettings().recordingsDir
      fs.mkdirSync(rootDir, { recursive: true })
      this.openHostFolderIfWindows(rootDir)
      this.sendJson(res, 200, { ok: true, path: rootDir })
      return
    }

    const recMatch = /^\/api\/recordings\/([^/]+)(?:\/(.+))?$/.exec(pathname)
    if (recMatch) {
      const recId = recMatch[1]
      const sub = recMatch[2]
      if (method === 'DELETE' && !sub) {
        this.recordingService.deleteRecording(recId)
        this.broadcast('recordings-updated', this.recordingService.listRecordings())
        this.broadcast('storage-stats-updated', this.recordingService.getStorageStats())
        this.sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && sub === 'star') {
        const updated = this.recordingService.toggleStar(recId)
        this.broadcast('recordings-updated', this.recordingService.listRecordings())
        this.broadcast('storage-stats-updated', this.recordingService.getStorageStats())
        this.sendJson(res, 200, updated)
        return
      }
      if (method === 'GET' && sub === 'download') {
        const item = this.recordingService.getRecordingById(recId)
        if (!item || !fs.existsSync(item.filePath)) {
          this.sendJson(res, 404, { error: 'Recording not found' })
          return
        }
        const stat = fs.statSync(item.filePath)
        const safeName = path.basename(item.fileName).replace(/["\r\n]/g, '_')
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${safeName}"`,
          'Cache-Control': 'no-store',
        })
        const stream = fs.createReadStream(item.filePath)
        stream.pipe(res)
        return
      }
      if (method === 'POST' && sub === 'evidence') {
        const item = this.recordingService.getRecordingById(recId)
        if (!item || !fs.existsSync(item.filePath)) {
          this.sendJson(res, 404, { error: 'Recording not found' })
          return
        }
        const evidenceDir = path.join(
          this.configStore.getPublicSettings().recordingsDir,
          'evidence-exports',
        )
        fs.mkdirSync(evidenceDir, { recursive: true })
        const bundle = this.recordingService.exportEvidenceBundle(recId, evidenceDir)
        this.sendJson(res, 200, bundle)
        return
      }
      if (method === 'POST' && sub === 'open-folder') {
        const item = this.recordingService.getRecordingById(recId)
        if (item && fs.existsSync(item.filePath)) {
          this.openHostFolderIfWindows(path.dirname(item.filePath), item.filePath)
        }
        this.sendJson(res, 200, { ok: true })
        return
      }
    }

    // Storage management
    if (method === 'GET' && pathname === '/api/storage/stats') {
      this.sendJson(res, 200, this.recordingService.getStorageStats())
      return
    }
    if (method === 'GET' && pathname === '/api/storage/drives') {
      this.sendJson(res, 200, await this.recordingService.listStorageDrives())
      return
    }
    if (method === 'POST' && pathname === '/api/storage/primary') {
      const body = await readJsonBody(req)
      const safePath = assertSafeDrivePath(body.drivePath)
      const targetDir = path.join(safePath, 'RingWatch_Recordings')
      fs.mkdirSync(targetDir, { recursive: true })
      const settings = this.configStore.updateSettings({ recordingsDir: targetDir })
      const { recordings, stats } = this.recordingService.rescanDirectory()
      this.ringService.syncNvrSettings()
      this.broadcast('settings-updated', settings)
      this.broadcast('recordings-updated', recordings)
      this.broadcast('storage-stats-updated', stats)
      this.sendJson(res, 200, { settings, stats })
      return
    }
    if (method === 'POST' && pathname === '/api/storage/failover') {
      const body = await readJsonBody(req)
      const safePath = assertSafeDrivePath(body.drivePath)
      const targetDir = path.join(safePath, 'RingWatch_Failover')
      fs.mkdirSync(targetDir, { recursive: true })
      const settings = this.configStore.updateSettings({
        failoverRecordingsDir: targetDir,
      })
      const stats = this.recordingService.getStorageStats()
      this.ringService.syncNvrSettings()
      this.broadcast('settings-updated', settings)
      this.broadcast('storage-stats-updated', stats)
      this.sendJson(res, 200, { settings, stats })
      return
    }
    if (method === 'DELETE' && pathname === '/api/storage/failover') {
      const settings = this.configStore.updateSettings({ failoverRecordingsDir: '' })
      const stats = this.recordingService.getStorageStats()
      this.ringService.syncNvrSettings()
      this.broadcast('settings-updated', settings)
      this.broadcast('storage-stats-updated', stats)
      this.sendJson(res, 200, { settings, stats })
      return
    }
    if (method === 'POST' && pathname === '/api/storage/rescan') {
      const { recordings, stats } = this.recordingService.rescanDirectory()
      this.broadcast('recordings-updated', recordings)
      this.broadcast('storage-stats-updated', stats)
      this.sendJson(res, 200, { recordings, stats })
      return
    }
    if (method === 'POST' && pathname === '/api/storage/prune') {
      const result = this.recordingService.enforceRetentionAndQuota()
      this.broadcast('recordings-updated', this.recordingService.listRecordings())
      this.broadcast('storage-stats-updated', result.stats)
      this.sendJson(res, 200, result)
      return
    }

    // AI Package Detection
    if (method === 'POST' && pathname === '/api/ai/scan') {
      const body = await readJsonBody(req)
      const cameraId = String(body.cameraId ?? '')
      const trigger =
        typeof body.trigger === 'string'
          ? (body.trigger as PackageDetectionRecord['trigger'])
          : 'manual'
      this.sendJson(
        res,
        200,
        await this.aiPackageService.scanCamera(cameraId, trigger),
      )
      return
    }
    if (method === 'GET' && pathname === '/api/ai/detections') {
      this.sendJson(res, 200, this.aiPackageService.listDetections())
      return
    }
    if (method === 'DELETE' && pathname === '/api/ai/detections') {
      this.aiPackageService.clearDetections()
      this.sendJson(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && pathname === '/api/ai/test-connection') {
      this.sendJson(res, 200, await this.aiPackageService.testConnection())
      return
    }
    if (method === 'POST' && pathname === '/api/ai/test-alert') {
      this.aiPackageService.sendTestAlert()
      this.sendJson(res, 200, { ok: true })
      return
    }

    // Demo simulator
    if (method === 'POST' && pathname === '/api/demo/simulate') {
      const body = await readJsonBody(req)
      const kind = String(body.kind ?? 'motion') as
        | 'doorbell'
        | 'motion'
        | 'contact-open'
        | 'package-delivery'
      await this.ringService.simulateDemoEvent(kind)
      this.sendJson(res, 200, { ok: true })
      return
    }

    // Settings
    if (method === 'PATCH' && pathname === '/api/settings') {
      const body = (await readJsonBody(req)) as AppSettingsPatch
      if (body.recordingsDir !== undefined && body.recordingsDir.trim()) {
        assertSafeDrivePath(body.recordingsDir)
        fs.mkdirSync(body.recordingsDir.trim(), { recursive: true })
      }
      if (
        body.failoverRecordingsDir !== undefined &&
        body.failoverRecordingsDir.trim()
      ) {
        assertSafeDrivePath(body.failoverRecordingsDir)
        fs.mkdirSync(body.failoverRecordingsDir.trim(), { recursive: true })
      }
      const updated = this.configStore.updateSettings(body)
      this.aiPackageService.syncScheduler()
      this.ringService.syncNvrSettings()
      this.broadcast('settings-updated', updated)
      this.broadcast('storage-stats-updated', this.recordingService.getStorageStats())
      this.sendJson(res, 200, updated)
      return
    }

    this.sendJson(res, 404, { error: `Unknown API endpoint: ${method} ${pathname}` })
  }

  private openHostFolderIfWindows(dirPath: string, selectFile?: string): void {
    try {
      if (process.platform === 'win32') {
        if (selectFile) {
          execFile('explorer.exe', [`/select,${selectFile}`])
        } else {
          execFile('explorer.exe', [dirPath])
        }
      } else if (process.platform === 'darwin') {
        if (selectFile) {
          execFile('open', ['-R', selectFile])
        } else {
          execFile('open', [dirPath])
        }
      } else if (process.platform === 'linux') {
        execFile('xdg-open', [dirPath])
      }
    } catch {
      // Ignore if running headless / as service
    }
  }

  private serveStaticFrontend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): void {
    if (!fs.existsSync(this.webDistDir)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(
        'RingWatch NVR & AI Backend is running.\nRun "npm run build" to serve the Web UI from this port, or open the Vite dev server at http://127.0.0.1:5173',
      )
      return
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    let candidate = path.resolve(this.webDistDir, rel)
    const rootWithSep = this.webDistDir.endsWith(path.sep)
      ? this.webDistDir
      : `${this.webDistDir}${path.sep}`

    if (
      candidate !== this.webDistDir &&
      !candidate.startsWith(rootWithSep)
    ) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    // SPA fallback to index.html for client-side routes
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      candidate = path.join(this.webDistDir, 'index.html')
      if (!fs.existsSync(candidate)) {
        res.writeHead(404)
        res.end('Web UI not built yet. Run npm run build.')
        return
      }
    }

    const ext = path.extname(candidate).toLowerCase()
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
    const stat = fs.statSync(candidate)
    const isHashedAsset = candidate.includes(`${path.sep}assets${path.sep}`)

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(candidate)
    stream.on('error', () => {
      if (!res.writableEnded) res.end()
    })
    stream.pipe(res)
  }
}
