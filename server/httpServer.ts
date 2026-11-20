import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import {
  ALL_PERMISSIONS,
  hasAnyPermission,
  hasPermission,
  type Permission,
  type UserRole,
} from '../shared/rbac'
import type {
  AppMode,
  AppSettingsPatch,
  AuthStatus,
  PackageDetectionRecord,
  PublicUser,
  RingWatchBootstrap,
} from '../shared/types'
import { ConfigStore } from './services/configStore'
import { StreamService } from './services/streamService'
import { RecordingService } from './services/recordingService'
import { NotificationService } from './services/notificationService'
import { AiPackageService } from './services/aiPackageService'
import { RingService } from './services/ringService'
import { BackendLogger } from './services/logger'
import { AuthService } from './services/authService'
import {
  FileKeyCryptoAdapter,
  createUserSessionToken,
  hashPassword,
  verifyPassword,
  verifyUserSessionToken,
} from './services/secretCrypto'

const SESSION_COOKIE_NAME = 'ringwatch_session'
const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60
const MAX_JSON_BODY_BYTES = 1024 * 1024 // 1 MB
const MAX_UPLOAD_MP4_BYTES = 500 * 1024 * 1024 // 500 MB

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

interface ResolvedSession {
  authenticated: boolean
  user: PublicUser | null
  permissions: Permission[]
}

interface SseClientEntry {
  res: http.ServerResponse
  userId: string | null
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
  readonly authService: AuthService
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
  private readonly sseClients = new Set<SseClientEntry>()
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

    // Migrate legacy single password hash (if any) into multi-user AuthService
    const legacyHash = this.configStore.getAuthPasswordHash()
    this.authService = new AuthService(options.dataDir, legacyHash)

    this.streamService = new StreamService(
      () => this.configStore.getPublicSettings().recordingsDir,
      () => this.recordingService?.getAllStorageRoots() ?? [],
    )
    this.streamService.attachToExternalServer()
    this.streamService.setOnStreamsChanged((sessions) => {
      this.broadcast('streams-updated', sessions, 'cameras:view')
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
      this.broadcast(channel, payload, 'ai:view')
    })

    this.aiPackageService = new AiPackageService({
      userDataDir: options.dataDir,
      configStore: this.configStore,
      notifications: this.notificationService,
      onDetection: (record) => {
        this.broadcast('package-detection', record, 'ai:view')
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
        onSettingsUpdated: (settings) =>
          this.broadcast('settings-updated', settings, 'settings:manage'),
        onLocationsUpdated: (locs) => this.broadcast('locations-updated', locs),
        onCamerasUpdated: (cams) => this.broadcast('cameras-updated', cams, 'cameras:view'),
        onSensorsUpdated: (sens) => this.broadcast('sensors-updated', sens, 'sensors:view'),
        onSecurityEvent: (ev) => this.broadcast('security-event', ev, 'sensors:view'),
        onEventsUpdated: (evs) => this.broadcast('events-updated', evs, 'sensors:view'),
        onNvrStatusUpdated: (nvr) =>
          this.broadcast('nvr-status-updated', nvr, 'recordings:view'),
        onRecordingsUpdated: (recs) =>
          this.broadcast('recordings-updated', recs, 'recordings:view'),
        onStorageStatsUpdated: (stats) =>
          this.broadcast('storage-stats-updated', stats, 'recordings:view'),
      },
    })
  }

  isAuthEnabled(): boolean {
    return (
      Boolean(this.envAuthPassword) ||
      this.authService.hasUsers() ||
      Boolean(this.configStore.getAuthPasswordHash())
    )
  }

  private resolveSession(req: http.IncomingMessage): ResolvedSession {
    if (!this.isAuthEnabled()) {
      return {
        authenticated: true,
        user: null,
        permissions: [...ALL_PERMISSIONS],
      }
    }

    const cookies = parseCookies(req.headers.cookie)
    const verified = verifyUserSessionToken(
      cookies[SESSION_COOKIE_NAME],
      this.sessionSigningKey,
    )
    if (!verified.valid) {
      return { authenticated: false, user: null, permissions: [] }
    }

    if (verified.userId === '__env_admin__') {
      if (this.envAuthPassword || this.configStore.getAuthPasswordHash()) {
        const ctx = this.authService.getEnvOrOpenAdminContext(true)
        return { authenticated: true, user: ctx.user, permissions: ctx.permissions }
      }
      return { authenticated: false, user: null, permissions: [] }
    }

    const active = this.authService.getActiveUserWithPermissions(verified.userId)
    if (!active) {
      return { authenticated: false, user: null, permissions: [] }
    }
    return {
      authenticated: true,
      user: active.user,
      permissions: active.permissions,
    }
  }

  getAuthStatus(req: http.IncomingMessage): AuthStatus {
    const authEnabled = this.isAuthEnabled()
    const session = this.resolveSession(req)
    return {
      authEnabled,
      authenticated: session.authenticated,
      managedByEnv: Boolean(this.envAuthPassword),
      hasUsers: this.authService.hasUsers(),
      hasPasskeys: this.authService.hasAnyPasskeys(),
      currentUser: session.user,
      permissions: session.permissions,
    }
  }

  private resolveWebAuthnContext(req: http.IncomingMessage): {
    rpID: string
    expectedOrigin: string
  } {
    const envRpId = (process.env.RINGWATCH_WEBAUTHN_RP_ID ?? '').trim()
    const envOrigin = (process.env.RINGWATCH_WEBAUTHN_ORIGIN ?? '').trim()

    let rpID = ''
    let expectedOrigin = ''

    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
    if (originHeader) {
      try {
        const parsed = new URL(originHeader)
        rpID = parsed.hostname
        expectedOrigin = parsed.origin
      } catch {
        // Fall back to Host header
      }
    }

    if (!rpID || !expectedOrigin) {
      const protoHeader =
        typeof req.headers['x-forwarded-proto'] === 'string'
          ? req.headers['x-forwarded-proto'].split(',')[0].trim()
          : 'http'
      const forwardedHost =
        typeof req.headers['x-forwarded-host'] === 'string'
          ? req.headers['x-forwarded-host'].split(',')[0].trim()
          : ''
      const hostHeader =
        forwardedHost ||
        (typeof req.headers.host === 'string' && req.headers.host.trim()
          ? req.headers.host.trim()
          : `localhost:${this.boundPort || this.requestedPort}`)
      const parsed = new URL(`${protoHeader}://${hostHeader}`)
      rpID = parsed.hostname
      expectedOrigin = parsed.origin
    }

    if (envRpId) rpID = envRpId
    if (envOrigin) expectedOrigin = envOrigin

    const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(rpID)
    const isIpv6 = rpID.includes(':') || rpID.startsWith('[')
    if (isIpv4 || isIpv6) {
      throw new Error(
        `Passkeys (Touch ID, 1Password, Windows Hello) require a domain name rather than an IP address (${rpID}). Open http://localhost:${this.boundPort || this.requestedPort} on this device or access RingWatch via an HTTPS hostname.`,
      )
    }

    return { rpID, expectedOrigin }
  }

  private buildSessionCookieHeader(token: string, maxAgeSeconds: number): string {
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
  }

  private getClientPermissions(userId: string | null): Permission[] {
    if (!this.isAuthEnabled() || userId === '__env_admin__') {
      return [...ALL_PERMISSIONS]
    }
    if (!userId) return []
    const active = this.authService.getActiveUserWithPermissions(userId)
    return active ? active.permissions : []
  }

  broadcast(channel: string, payload: unknown, requiredPerm?: Permission): void {
    if (this.sseClients.size === 0) return
    const frame = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of Array.from(this.sseClients)) {
      try {
        if (client.res.writableEnded || client.res.destroyed) {
          this.sseClients.delete(client)
          continue
        }
        if (requiredPerm) {
          const perms = this.getClientPermissions(client.userId)
          if (!hasPermission(perms, requiredPerm)) continue
        }
        client.res.write(frame)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  private requirePerm(
    res: http.ServerResponse,
    session: ResolvedSession,
    perm: Permission,
  ): boolean {
    if (hasPermission(session.permissions, perm)) return true
    this.sendJson(res, 403, {
      error: `Permission denied: requires "${perm}" access.`,
    })
    return false
  }

  private requireAnyPerm(
    res: http.ServerResponse,
    session: ResolvedSession,
    perms: Permission[],
  ): boolean {
    if (hasAnyPermission(session.permissions, perms)) return true
    this.sendJson(res, 403, {
      error: `Permission denied: requires one of [${perms.join(', ')}].`,
    })
    return false
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
          if (!client.res.writableEnded && !client.res.destroyed) {
            client.res.write(': ping\n\n')
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

    void this.ringService.initialize().catch((err) => {
      console.warn('[RingWatch Server] Initialization warning:', err)
    })
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      try {
        const res = this.recordingService.rescanDirectory()
        this.broadcast('recordings-updated', res.recordings, 'recordings:view')
        this.broadcast('storage-stats-updated', res.stats, 'recordings:view')
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
        client.res.end()
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
      const session = this.resolveSession(req)
      if (!session.authenticated) {
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
      const isHls = pathname.includes('/hls/')
      const requiredPerm: Permission = isHls ? 'cameras:view' : 'recordings:view'
      if (!hasPermission(session.permissions, requiredPerm)) {
        res.writeHead(403)
        res.end('Forbidden')
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

    // Password login (multi-user or env admin override)
    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req)
      const password = typeof body.password === 'string' ? body.password : ''
      const username = typeof body.username === 'string' ? body.username.trim() : ''

      if (!this.isAuthEnabled()) {
        this.sendJson(res, 200, { ok: true })
        return
      }

      // 1. Try multi-user accounts first
      if (this.authService.hasUsers()) {
        const user = this.authService.authenticateWithPassword(password, username || undefined)
        if (user) {
          const token = createUserSessionToken(this.sessionSigningKey, user.id)
          this.sendJson(
            res,
            200,
            { ok: true, user },
            { 'Set-Cookie': this.buildSessionCookieHeader(token, SESSION_MAX_AGE_SEC) },
          )
          return
        }
      }

      // 2. Fallback to RINGWATCH_AUTH_PASSWORD env override or legacy hash
      const envOrLegacy = this.envAuthPassword ?? this.configStore.getAuthPasswordHash()
      if (
        envOrLegacy &&
        (!username || username.toLowerCase() === 'admin') &&
        verifyPassword(password, envOrLegacy)
      ) {
        const token = createUserSessionToken(this.sessionSigningKey, '__env_admin__')
        this.sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': this.buildSessionCookieHeader(token, SESSION_MAX_AGE_SEC) },
        )
        return
      }

      this.sendJson(res, 401, { ok: false, error: 'Invalid username or password.' })
      return
    }

    // Passkey (WebAuthn) Sign-In Step 1: Challenge Options
    if (method === 'POST' && pathname === '/api/auth/passkey/login-options') {
      const body = await readJsonBody(req)
      const username = typeof body.username === 'string' ? body.username.trim() : undefined
      const { rpID, expectedOrigin } = this.resolveWebAuthnContext(req)
      const result = await this.authService.createPasskeyAuthenticationOptions({
        username,
        rpID,
        expectedOrigin,
      })
      this.sendJson(res, 200, result)
      return
    }

    // Passkey (WebAuthn) Sign-In Step 2: Verify Assertion & Issue Session Cookie
    if (method === 'POST' && pathname === '/api/auth/passkey/login-verify') {
      const body = await readJsonBody(req)
      const challengeId = typeof body.challengeId === 'string' ? body.challengeId : ''
      const response = body.response as AuthenticationResponseJSON
      try {
        const user = await this.authService.verifyPasskeyAuthentication({
          challengeId,
          response,
        })
        const token = createUserSessionToken(this.sessionSigningKey, user.id)
        this.sendJson(
          res,
          200,
          { ok: true, user },
          { 'Set-Cookie': this.buildSessionCookieHeader(token, SESSION_MAX_AGE_SEC) },
        )
      } catch (err) {
        this.sendJson(res, 401, {
          ok: false,
          error: err instanceof Error ? err.message : 'Passkey authentication failed.',
        })
      }
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

    // Enforce authentication for all protected API routes
    const session = this.resolveSession(req)
    if (!session.authenticated) {
      this.sendJson(res, 401, { error: 'Authentication required' })
      return
    }

    // Self-service Passkey registration (requires a real user account)
    if (method === 'POST' && pathname === '/api/auth/passkey/register-options') {
      if (!session.user || session.user.id === '__env_admin__') {
        this.sendJson(res, 400, {
          error: 'Create an Admin user account first before registering a Passkey.',
        })
        return
      }
      const body = await readJsonBody(req)
      const rawType = typeof body.authenticatorType === 'string' ? body.authenticatorType : 'any'
      const authenticatorType: 'any' | 'platform' | 'cross-platform' =
        rawType === 'platform' || rawType === 'cross-platform' ? rawType : 'any'
      const { rpID, expectedOrigin } = this.resolveWebAuthnContext(req)
      const result = await this.authService.createPasskeyRegistrationOptions({
        userId: session.user.id,
        rpID,
        expectedOrigin,
        authenticatorType,
      })
      this.sendJson(res, 200, result)
      return
    }

    if (method === 'POST' && pathname === '/api/auth/passkey/register-verify') {
      if (!session.user || session.user.id === '__env_admin__') {
        this.sendJson(res, 400, {
          error: 'Create an Admin user account first before registering a Passkey.',
        })
        return
      }
      const body = await readJsonBody(req)
      const challengeId = typeof body.challengeId === 'string' ? body.challengeId : ''
      const name = typeof body.name === 'string' ? body.name : 'Passkey'
      const response = body.response as RegistrationResponseJSON
      const passkey = await this.authService.verifyPasskeyRegistration({
        userId: session.user.id,
        challengeId,
        name,
        response,
      })
      this.sendJson(res, 200, { ok: true, passkey })
      return
    }

    const myPasskeyMatch = /^\/api\/auth\/passkeys\/([^/]+)$/.exec(pathname)
    if (method === 'DELETE' && myPasskeyMatch) {
      if (!session.user || session.user.id === '__env_admin__') {
        this.sendJson(res, 400, { error: 'No user account active.' })
        return
      }
      this.authService.removePasskey(session.user.id, myPasskeyMatch[1], false)
      this.sendJson(res, 200, { ok: true })
      return
    }

    // Self-service password change
    if (method === 'POST' && pathname === '/api/auth/change-password') {
      if (!session.user || session.user.id === '__env_admin__') {
        this.sendJson(res, 400, {
          ok: false,
          error: 'No user account active (managed by environment or open mode).',
        })
        return
      }
      const body = await readJsonBody(req)
      const currentPassword =
        typeof body.currentPassword === 'string' ? body.currentPassword : undefined
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
      this.authService.changePassword(session.user.id, currentPassword, newPassword)
      this.sendJson(res, 200, { ok: true })
      return
    }

    // Backwards-compatible quick single-password toggle (for legacy clients/tests)
    if (method === 'POST' && pathname === '/api/auth/password') {
      if (!this.requirePerm(res, session, 'users:manage')) return
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
          { ok: true, authEnabled: this.isAuthEnabled() },
          { 'Set-Cookie': this.buildSessionCookieHeader('', 0) },
        )
        return
      }

      if (newPassword.length < 4) {
        this.sendJson(res, 400, {
          ok: false,
          authEnabled: this.isAuthEnabled(),
          error: 'Password must be at least 4 characters.',
        })
        return
      }

      this.configStore.setAuthPasswordHash(hashPassword(newPassword))
      const token = createUserSessionToken(this.sessionSigningKey, '__env_admin__')
      this.sendJson(
        res,
        200,
        { ok: true, authEnabled: true },
        { 'Set-Cookie': this.buildSessionCookieHeader(token, SESSION_MAX_AGE_SEC) },
      )
      return
    }

    // Multi-User & RBAC Administration (/api/users)
    if (method === 'GET' && pathname === '/api/users') {
      if (!this.requirePerm(res, session, 'users:manage')) return
      this.sendJson(res, 200, this.authService.listUsers())
      return
    }

    if (method === 'POST' && pathname === '/api/users') {
      if (!this.requirePerm(res, session, 'users:manage')) return
      const body = await readJsonBody(req)
      const wasFirstUser = !this.authService.hasUsers()
      const created = this.authService.createUser({
        username: String(body.username ?? ''),
        displayName: String(body.displayName ?? body.username ?? ''),
        role: (typeof body.role === 'string' ? body.role : 'viewer') as UserRole,
        customPermissions: Array.isArray(body.customPermissions)
          ? (body.customPermissions as Permission[])
          : undefined,
        password: typeof body.password === 'string' ? body.password : undefined,
      })
      // When creating the very first Admin user from open mode, automatically log them in
      if (wasFirstUser) {
        const token = createUserSessionToken(this.sessionSigningKey, created.id)
        this.sendJson(
          res,
          201,
          created,
          { 'Set-Cookie': this.buildSessionCookieHeader(token, SESSION_MAX_AGE_SEC) },
        )
        return
      }
      this.sendJson(res, 201, created)
      return
    }

    const userPkMatch = /^\/api\/users\/([^/]+)\/passkeys\/([^/]+)$/.exec(pathname)
    if (method === 'DELETE' && userPkMatch) {
      if (!this.requirePerm(res, session, 'users:manage')) return
      this.authService.removePasskey(userPkMatch[1], userPkMatch[2], true)
      this.sendJson(res, 200, { ok: true })
      return
    }

    const userMatch = /^\/api\/users\/([^/]+)$/.exec(pathname)
    if (userMatch) {
      if (!this.requirePerm(res, session, 'users:manage')) return
      const targetId = userMatch[1]
      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = this.authService.updateUser(targetId, {
          displayName:
            typeof body.displayName === 'string' ? body.displayName : undefined,
          role: typeof body.role === 'string' ? (body.role as UserRole) : undefined,
          customPermissions: Array.isArray(body.customPermissions)
            ? (body.customPermissions as Permission[])
            : undefined,
          disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
          password: typeof body.password === 'string' ? body.password : undefined,
        })
        this.sendJson(res, 200, updated)
        return
      }
      if (method === 'DELETE') {
        this.authService.deleteUser(targetId)
        this.sendJson(res, 200, { ok: true })
        return
      }
    }

    // Troubleshooting logs API (admin/settings only)
    if (method === 'GET' && pathname === '/api/logs') {
      if (!this.requirePerm(res, session, 'settings:manage')) return
      this.sendJson(res, 200, {
        logsDir: this.logger.logsDir,
        logFilePath: this.logger.logFilePath,
        debugEnabled: this.logger.debugEnabled,
        lines: this.logger.readRecentLines(400),
      })
      return
    }

    if (method === 'GET' && pathname === '/api/logs/download') {
      if (!this.requirePerm(res, session, 'settings:manage')) return
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

    // Real-time Server-Sent Events stream (permission-filtered per subscriber)
    if (method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('event: connected\ndata: {"ok":true}\n\n')
      const entry: SseClientEntry = {
        res,
        userId: session.user?.id ?? (this.isAuthEnabled() ? null : '__env_admin__'),
      }
      this.sseClients.add(entry)
      req.on('close', () => {
        this.sseClients.delete(entry)
      })
      return
    }

    // Permission-scoped Bootstrap payload
    if (method === 'GET' && pathname === '/api/bootstrap') {
      const canCameras = hasPermission(session.permissions, 'cameras:view')
      const canRecs = hasPermission(session.permissions, 'recordings:view')
      const canSensors = hasPermission(session.permissions, 'sensors:view')
      const canAi = hasPermission(session.permissions, 'ai:view')
      const payload: RingWatchBootstrap = {
        connection: this.ringService.getConnection(),
        settings: this.configStore.getPublicSettings(),
        storageStats: this.recordingService.getStorageStats(),
        nvrStatus: this.ringService.getNvrStatus(),
        locations: this.ringService.getLocations(),
        cameras: canCameras ? this.ringService.getCameras() : [],
        sensors: canSensors ? this.ringService.getSensors() : [],
        events: canSensors || canRecs ? this.ringService.getEvents() : [],
        recordings: canRecs ? this.recordingService.listRecordings() : [],
        packageDetections: canAi ? this.aiPackageService.listDetections() : [],
        activeStreams: canCameras ? this.streamService.listActiveSessions() : [],
        authStatus: this.getAuthStatus(req),
      }
      this.sendJson(res, 200, payload)
      return
    }

    // Connection & Ring Account (settings:manage)
    if (method === 'POST' && pathname === '/api/connection/token') {
      if (!this.requirePerm(res, session, 'settings:manage')) return
      const body = await readJsonBody(req)
      const token = typeof body.refreshToken === 'string' ? body.refreshToken : ''
      this.sendJson(res, 200, await this.ringService.connectWithToken(token))
      return
    }
    if (method === 'POST' && pathname === '/api/connection/login') {
      if (!this.requirePerm(res, session, 'settings:manage')) return
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
      if (!this.requirePerm(res, session, 'settings:manage')) return
      this.sendJson(res, 200, await this.ringService.disconnectRing())
      return
    }
    if (method === 'POST' && pathname === '/api/connection/mode') {
      if (!this.requirePerm(res, session, 'settings:manage')) return
      const body = await readJsonBody(req)
      const mode = body.mode === 'live' ? 'live' : ('demo' as AppMode)
      this.sendJson(res, 200, await this.ringService.switchMode(mode))
      return
    }
    if (method === 'POST' && pathname === '/api/connection/refresh') {
      if (!this.requireAnyPerm(res, session, ['cameras:view', 'sensors:view'])) return
      this.sendJson(res, 200, await this.ringService.refreshDevices())
      return
    }

    // Camera controls & live streams
    const camMatch = /^\/api\/cameras\/([^/]+)\/(.+)$/.exec(pathname)
    if (camMatch) {
      const cameraId = camMatch[1]
      const action = camMatch[2]
      if (method === 'POST' && action === 'stream/start') {
        if (!this.requirePerm(res, session, 'cameras:view')) return
        this.sendJson(res, 200, await this.ringService.startLiveStream(cameraId))
        return
      }
      if (method === 'POST' && action === 'stream/stop') {
        if (!this.requirePerm(res, session, 'cameras:view')) return
        this.ringService.stopLiveStream(cameraId)
        this.sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && action === 'snapshot') {
        if (!this.requirePerm(res, session, 'cameras:view')) return
        this.sendJson(res, 200, await this.ringService.captureSnapshot(cameraId))
        return
      }
      if (method === 'POST' && action === 'light') {
        if (!this.requirePerm(res, session, 'cameras:control')) return
        const body = await readJsonBody(req)
        this.sendJson(
          res,
          200,
          await this.ringService.toggleCameraLight(cameraId, Boolean(body.on)),
        )
        return
      }
      if (method === 'POST' && action === 'siren') {
        if (!this.requirePerm(res, session, 'cameras:control')) return
        const body = await readJsonBody(req)
        this.sendJson(
          res,
          200,
          await this.ringService.toggleCameraSiren(cameraId, Boolean(body.on)),
        )
        return
      }
      if (method === 'GET' && action === 'cloud-recordings') {
        if (!this.requirePerm(res, session, 'recordings:view')) return
        this.sendJson(res, 200, await this.ringService.listCloudRecordings(cameraId))
        return
      }
      const cloudDlMatch = /^cloud-recordings\/([^/]+)\/download$/.exec(action)
      if (method === 'POST' && cloudDlMatch) {
        if (!this.requirePerm(res, session, 'recordings:manage')) return
        this.sendJson(
          res,
          200,
          await this.ringService.downloadCloudRecording(cameraId, cloudDlMatch[1]),
        )
        return
      }
    }

    // Alarm mode (sensors:arm)
    const locAlarmMatch = /^\/api\/locations\/([^/]+)\/alarm$/.exec(pathname)
    if (method === 'POST' && locAlarmMatch) {
      if (!this.requirePerm(res, session, 'sensors:arm')) return
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
      if (!this.requireAnyPerm(res, session, ['nvr:manage', 'recordings:view', 'cameras:view'])) return
      this.sendJson(res, 200, this.ringService.getNvrStatus())
      return
    }
    if (method === 'POST' && pathname === '/api/nvr/start') {
      if (!this.requirePerm(res, session, 'nvr:manage')) return
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
      if (!this.requirePerm(res, session, 'nvr:manage')) return
      this.sendJson(res, 200, await this.ringService.stopAllCameraRecording())
      return
    }
    const nvrCamMatch = /^\/api\/nvr\/camera\/([^/]+)$/.exec(pathname)
    if (method === 'POST' && nvrCamMatch) {
      if (!this.requirePerm(res, session, 'nvr:manage')) return
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
      if (!this.requirePerm(res, session, 'recordings:view')) return
      this.sendJson(res, 200, await this.ringService.syncCloudEventsToTimeline())
      return
    }

    // Recordings & local vault
    if (method === 'GET' && pathname === '/api/recordings') {
      if (!this.requirePerm(res, session, 'recordings:view')) return
      this.sendJson(res, 200, this.recordingService.listRecordings())
      return
    }
    if (method === 'DELETE' && pathname === '/api/recordings') {
      if (!this.requirePerm(res, session, 'recordings:manage')) return
      const searchParams = new URL(req.url ?? '/', 'http://localhost').searchParams
      const includeStarred = searchParams.get('includeStarred') !== '0'
      const result = this.recordingService.clearAllRecordings(includeStarred)
      this.broadcast('recordings-updated', this.recordingService.listRecordings(), 'recordings:view')
      this.broadcast('storage-stats-updated', result.stats, 'recordings:view')
      this.sendJson(res, 200, result)
      return
    }
    if (method === 'POST' && pathname === '/api/recordings/import') {
      if (!this.requirePerm(res, session, 'recordings:manage')) return
      const rawNameHeader = req.headers['x-filename']
      let rawName = Array.isArray(rawNameHeader) ? rawNameHeader[0] : (rawNameHeader ?? 'imported.mp4')
      try {
        rawName = decodeURIComponent(rawName)
      } catch {
        // Keep raw header if not percent-encoded
      }
      const tempPath = path.join(os.tmpdir(), `ringwatch-upload-${crypto.randomUUID()}.mp4`)
      let totalBytes = 0
      let aborted = false
      try {
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(tempPath)
          const fail = (err: Error) => {
            if (aborted) return
            aborted = true
            out.destroy()
            reject(err)
          }
          req.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length
            if (totalBytes > MAX_UPLOAD_MP4_BYTES) {
              fail(new Error('Uploaded MP4 exceeds 500 MB limit'))
              req.resume()
              return
            }
            if (!aborted) {
              out.write(chunk)
            }
          })
          req.on('end', () => {
            if (!aborted) out.end()
          })
          req.on('error', (err) => fail(err))
          out.on('error', (err) => fail(err))
          out.on('finish', () => {
            if (!aborted) resolve()
          })
        })
        if (totalBytes === 0) {
          fs.rmSync(tempPath, { force: true })
          this.sendJson(res, 400, { error: 'Uploaded file is empty.' })
          return
        }
        const item = this.recordingService.registerUploadedMp4(rawName, tempPath)
        this.broadcast('recordings-updated', this.recordingService.listRecordings(), 'recordings:view')
        this.broadcast('storage-stats-updated', this.recordingService.getStorageStats(), 'recordings:view')
        this.sendJson(res, 201, item)
      } catch (err) {
        try {
          fs.rmSync(tempPath, { force: true })
        } catch {
          // ignore
        }
        const msg = err instanceof Error ? err.message : 'Failed to import video'
        const status = msg.includes('500 MB') ? 413 : 400
        this.sendJson(res, status, { error: msg })
      }
      return
    }
    if (method === 'POST' && pathname === '/api/recordings/capture') {
      if (!this.requirePerm(res, session, 'recordings:manage')) return
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
      if (!this.requirePerm(res, session, 'recordings:view')) return
      const rootDir = this.configStore.getPublicSettings().recordingsDir
      fs.mkdirSync(rootDir, { recursive: true })
      this.openHostFolder(rootDir)
      this.sendJson(res, 200, { ok: true, path: rootDir })
      return
    }

    const recMatch = /^\/api\/recordings\/([^/]+)(?:\/(.+))?$/.exec(pathname)
    if (recMatch) {
      const recId = recMatch[1]
      const sub = recMatch[2]
      if (method === 'DELETE' && !sub) {
        if (!this.requirePerm(res, session, 'recordings:manage')) return
        this.recordingService.deleteRecording(recId)
        this.broadcast('recordings-updated', this.recordingService.listRecordings(), 'recordings:view')
        this.broadcast('storage-stats-updated', this.recordingService.getStorageStats(), 'recordings:view')
        this.sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && sub === 'star') {
        if (!this.requirePerm(res, session, 'recordings:manage')) return
        const updated = this.recordingService.toggleStar(recId)
        this.broadcast('recordings-updated', this.recordingService.listRecordings(), 'recordings:view')
        this.broadcast('storage-stats-updated', this.recordingService.getStorageStats(), 'recordings:view')
        this.sendJson(res, 200, updated)
        return
      }
      if (method === 'GET' && sub === 'download') {
        if (!this.requirePerm(res, session, 'recordings:view')) return
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
        if (!this.requirePerm(res, session, 'recordings:manage')) return
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
        const safeFileName = path.basename(item.fileName).replace(/[^a-zA-Z0-9._-]/g, '_')
        const destMp4Path = path.join(evidenceDir, safeFileName)
        const bundle = this.recordingService.exportEvidenceBundle(recId, destMp4Path)
        this.sendJson(res, 200, bundle)
        return
      }
      if (method === 'POST' && sub === 'open-folder') {
        if (!this.requirePerm(res, session, 'recordings:view')) return
        const item = this.recordingService.getRecordingById(recId)
        if (!item || !fs.existsSync(item.filePath)) {
          this.sendJson(res, 404, { error: 'Recording not found on disk' })
          return
        }
        const dir = path.dirname(item.filePath)
        this.openHostFolder(dir, item.filePath)
        this.sendJson(res, 200, { ok: true, path: item.filePath, dir })
        return
      }
    }

    // Storage management
    if (method === 'GET' && pathname === '/api/storage/stats') {
      if (!this.requireAnyPerm(res, session, ['nvr:manage', 'recordings:view'])) return
      this.sendJson(res, 200, this.recordingService.getStorageStats())
      return
    }
    if (method === 'GET' && pathname === '/api/storage/drives') {
      if (!this.requirePerm(res, session, 'nvr:manage')) return
      this.sendJson(res, 200, await this.recordingService.listStorageDrives())
      return
    }
    if (method === 'POST' && pathname === '/api/storage/primary') {
      if (!this.requirePerm(res, session, 'nvr:manage')) return
      const body = await readJsonBody(req)
      const safePath = assertSafeDrivePath(body.drivePath)
      const targetDir = path.join(safePath, 'RingWatch_Recordings')
      fs.mkdirSync(targetDir, { recursive: true })
      const settings = this.configStore.updateSettings({ recordingsDir: targetDir })
      const { recordings, stats } = this.recordingService.rescanDirectory()
      this.ringService.syncNvrSettings()
      this.broadcast('settings-updated', settings, 'settings:manage')
      this.broadcast('recordings-updated', recordings, 'recordings:view')
      this.broadcast('storage-stats-updated', stats, 'recordings:view')
      this.sendJson(res, 200, { settings, stats })
      return
    }
    if (method === 'POST' && pathname === '/api/storage/failover') {
      if (!this.requirePerm(res, session, 'nvr:manage')) return
      const body = await readJsonBody(req)
      const safePath = assertSafeDrivePath(body.drivePath)
      const targetDir = path.join(safePath, 'RingWatch_Failover')
      fs.mkdirSync(targetDir, { recursive: true })
      const settings = this.configStore.updateSettings({
        failoverRecordingsDir: targetDir,
      })
      const stats = this.recordingService.getStorageStats()
      this.ringService.syncNvrSettings()
      this.broadcast('settings-updated', settings, 'settings:manage')
      this.broadcast('storage-stats-updated', stats, 'recordings:view')
      this.sendJson(res, 200, { settings, stats })
      return
    }
    if (method === 'DELETE' && pathname === '/api/storage/failover') {
      if (!this.requirePerm(res, session, 'nvr:manage')) return
      const settings = this.configStore.updateSettings({ failoverRecordingsDir: '' })
      const stats = this.recordingService.getStorageStats()
      this.ringService.syncNvrSettings()
      this.broadcast('settings-updated', settings, 'settings:manage')
      this.broadcast('storage-stats-updated', stats, 'recordings:view')
      this.sendJson(res, 200, { settings, stats })
      return
    }
    if (method === 'POST' && pathname === '/api/storage/rescan') {
      if (!this.requirePerm(res, session, 'nvr:manage')) return
      const { recordings, stats } = this.recordingService.rescanDirectory()
      this.broadcast('recordings-updated', recordings, 'recordings:view')
      this.broadcast('storage-stats-updated', stats, 'recordings:view')
      this.sendJson(res, 200, { recordings, stats })
      return
    }
    if (method === 'POST' && pathname === '/api/storage/prune') {
      if (!this.requirePerm(res, session, 'nvr:manage')) return
      const result = this.recordingService.enforceRetentionAndQuota()
      this.broadcast('recordings-updated', this.recordingService.listRecordings(), 'recordings:view')
      this.broadcast('storage-stats-updated', result.stats, 'recordings:view')
      this.sendJson(res, 200, result)
      return
    }

    // AI Package Detection
    if (method === 'POST' && pathname === '/api/ai/scan') {
      if (!this.requirePerm(res, session, 'ai:manage')) return
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
      if (!this.requirePerm(res, session, 'ai:view')) return
      this.sendJson(res, 200, this.aiPackageService.listDetections())
      return
    }
    if (method === 'DELETE' && pathname === '/api/ai/detections') {
      if (!this.requirePerm(res, session, 'ai:manage')) return
      this.aiPackageService.clearDetections()
      this.sendJson(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && pathname === '/api/ai/test-connection') {
      if (!this.requireAnyPerm(res, session, ['ai:manage', 'settings:manage'])) return
      this.sendJson(res, 200, await this.aiPackageService.testConnection())
      return
    }
    if (method === 'POST' && pathname === '/api/ai/test-alert') {
      if (!this.requirePerm(res, session, 'ai:manage')) return
      this.aiPackageService.sendTestAlert()
      this.sendJson(res, 200, { ok: true })
      return
    }

    // Demo simulator
    if (method === 'POST' && pathname === '/api/demo/simulate') {
      if (!this.requireAnyPerm(res, session, ['cameras:control', 'ai:manage', 'settings:manage'])) return
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

    // Settings (scope: ai:manage for packageAi rules without API keys, nvr:manage for NVR fields, settings:manage for everything)
    if (method === 'PATCH' && pathname === '/api/settings') {
      const body = (await readJsonBody(req)) as AppSettingsPatch
      const keys = Object.keys(body)
      const isPureAiRules =
        keys.length === 1 &&
        keys[0] === 'packageAi' &&
        !body.packageAi?.openaiApiKey &&
        !body.packageAi?.geminiApiKey
      const nvrKeys = new Set([
        'continuousSegmentSeconds',
        'continuousSkipBatteryCams',
        'continuousAutoStart',
        'continuousCameraIds',
        'maxStorageGb',
        'retentionDays',
        'lowDiskWarningGb',
        'minFreeDiskGb',
        'organizeByDateFolder',
        'nvrNotificationsEnabled',
        'preventSleepWhileRecording',
        'recordingsDir',
        'failoverRecordingsDir',
      ])
      const isPureNvrPatch = keys.length > 0 && keys.every((k) => nvrKeys.has(k))

      if (isPureAiRules) {
        if (!this.requireAnyPerm(res, session, ['ai:manage', 'settings:manage'])) return
      } else if (isPureNvrPatch) {
        if (!this.requireAnyPerm(res, session, ['nvr:manage', 'settings:manage'])) return
      } else {
        if (!this.requirePerm(res, session, 'settings:manage')) return
      }

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
      this.broadcast('settings-updated', updated, 'settings:manage')
      this.broadcast('storage-stats-updated', this.recordingService.getStorageStats(), 'recordings:view')
      this.sendJson(res, 200, updated)
      return
    }

    this.sendJson(res, 404, { error: `Unknown API endpoint: ${method} ${pathname}` })
  }

  private openHostFolder(dirPath: string, selectFile?: string): void {
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
