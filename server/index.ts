import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RingWatchServer } from './httpServer'
import { BackendLogger } from './services/logger'

// Keep 24/7 unattended NVR resilient against transient Windows OS/socket errors (EBUSY/ENOTEMPTY/EPIPE)
const TRANSIENT_ERROR_CODES = new Set([
  'ENOTEMPTY',
  'EBUSY',
  'EPERM',
  'ENOENT',
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
])

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code && TRANSIENT_ERROR_CODES.has(err.code)) {
    console.warn('[RingWatch Server] Suppressed transient error:', err.code, err.message)
    return
  }
  console.error('[RingWatch Server] Uncaught exception:', err)
})

process.on('unhandledRejection', (reason) => {
  console.warn('[RingWatch Server] Unhandled promise rejection:', reason)
})

function resolveProjectRoot(): string {
  // Compiled file lives at dist-server/server/index.js
  return path.resolve(__dirname, '..', '..')
}

function resolveDefaultDataDir(): string {
  if (process.env.RINGWATCH_DATA_DIR?.trim()) {
    return path.resolve(process.env.RINGWATCH_DATA_DIR.trim())
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'RingWatch')
  }
  return path.join(os.homedir(), '.ringwatch')
}

function resolveDefaultRecordingsDir(): string {
  if (process.env.RINGWATCH_RECORDINGS_DIR?.trim()) {
    return path.resolve(process.env.RINGWATCH_RECORDINGS_DIR.trim())
  }
  return path.join(os.homedir(), 'Videos', 'RingWatch')
}

function resolveLogsDir(dataDir: string): string {
  if (process.env.RINGWATCH_LOG_DIR?.trim()) {
    return path.resolve(process.env.RINGWATCH_LOG_DIR.trim())
  }
  return path.join(dataDir, 'logs')
}

function resolveDemoAssetsDir(root: string): string {
  const distDemo = path.join(root, 'dist', 'demo')
  if (fs.existsSync(distDemo)) return distDemo
  return path.join(root, 'public', 'demo')
}

function listLanIpv4Addresses(): string[] {
  const out: string[] = []
  const nets = os.networkInterfaces()
  for (const entries of Object.values(nets)) {
    for (const addr of entries ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push(addr.address)
      }
    }
  }
  return out
}

async function main(): Promise<void> {
  const root = resolveProjectRoot()
  const host = process.env.HOST?.trim() || '0.0.0.0'
  const parsedPort = Number(process.env.PORT ?? 3456)
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3456
  const dataDir = resolveDefaultDataDir()
  const defaultRecordingsDir = resolveDefaultRecordingsDir()
  const logsDir = resolveLogsDir(dataDir)
  const debugEnabled =
    process.env.RINGWATCH_DEBUG === '1' ||
    process.env.RINGWATCH_DEBUG?.toLowerCase() === 'true'
  const webDistDir = path.join(root, 'dist')
  const demoAssetsDir = resolveDemoAssetsDir(root)

  const logger = new BackendLogger({ logsDir, debugEnabled })
  logger.installConsoleCapture()

  let shuttingDown = false
  let serverRef: RingWatchServer | null = null
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[RingWatch Server] Received ${signal}, shutting down cleanly...`)
    try {
      await serverRef?.stop()
    } finally {
      process.exit(0)
    }
  }

  const rawHttpsPort = process.env.RINGWATCH_HTTPS_PORT ?? process.env.HTTPS_PORT
  const parsedHttpsPort = rawHttpsPort !== undefined ? Number(rawHttpsPort) : undefined
  const httpsPort =
    parsedHttpsPort !== undefined && Number.isFinite(parsedHttpsPort) && parsedHttpsPort > 0
      ? parsedHttpsPort
      : undefined
  const rawHttpsEnabled = process.env.RINGWATCH_HTTPS_ENABLED?.trim().toLowerCase()
  const httpsEnabled =
    rawHttpsEnabled === '0' || rawHttpsEnabled === 'false'
      ? false
      : rawHttpsEnabled === '1' || rawHttpsEnabled === 'true'
        ? true
        : undefined

  const server = new RingWatchServer({
    dataDir,
    defaultRecordingsDir,
    webDistDir,
    demoAssetsDir,
    host,
    port,
    httpsPort,
    httpsEnabled,
    tlsCertPath: process.env.RINGWATCH_TLS_CERT_PATH,
    tlsKeyPath: process.env.RINGWATCH_TLS_KEY_PATH,
    tlsCaPath: process.env.RINGWATCH_TLS_CA_PATH,
    envAuthPassword: process.env.RINGWATCH_AUTH_PASSWORD,
    logger,
    controlToken: process.env.RINGWATCH_CONTROL_TOKEN,
    onRequestShutdown: () => {
      void shutdown('WINDOWS_SERVICE_STOP')
    },
  })
  serverRef = server

  const bound = await server.start()
  const tlsStatus = server.getTlsStatus()
  console.log('')
  console.log('==============================================================')
  console.log('  RingWatch 24/7 NVR & AI Package Backend')
  console.log('==============================================================')
  console.log(`  Local HTTP   : http://localhost:${bound.port}`)
  if (bound.httpsPort) {
    console.log(`  Local HTTPS  : https://localhost:${bound.httpsPort}`)
  }
  if (host === '0.0.0.0') {
    for (const ip of listLanIpv4Addresses()) {
      console.log(`  LAN HTTP     : http://${ip}:${bound.port}`)
      if (bound.httpsPort) {
        console.log(`  LAN HTTPS    : https://${ip}:${bound.httpsPort}`)
      }
    }
  }
  console.log(
    `  TLS Cert     : ${
      tlsStatus.active
        ? `${tlsStatus.certSource} (${tlsStatus.daysRemaining ?? '?'}d remaining${tlsStatus.autoRenewEnabled ? ', auto-renew ON' : ''})`
        : tlsStatus.lastError
          ? `Disabled/Error (${tlsStatus.lastError})`
          : 'Disabled'
    }`,
  )
  console.log(`  Data Folder  : ${dataDir}`)
  console.log(`  Recordings   : ${server.configStore.getPublicSettings().recordingsDir}`)
  console.log(`  Logs Folder  : ${logsDir}${debugEnabled ? ' (VERBOSE DEBUG ON)' : ''}`)
  console.log(
    `  Web Login    : ${server.isAuthEnabled() ? 'Enabled (password protected)' : 'Disabled (open on LAN — configure in Settings or RINGWATCH_AUTH_PASSWORD)'}`,
  )
  console.log('==============================================================')
  console.log('')

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

void main().catch((err) => {
  console.error('[RingWatch Server] Fatal startup error:', err)
  process.exit(1)
})
