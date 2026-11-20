import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024 // 5 MB per log file
const MAX_ARCHIVES = 3
const MEMORY_RING_LIMIT = 800

function sanitizeLogText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED_OPENAI_KEY]')
    .replace(/(AIza[0-9A-Za-z_-]{20,})/g, '[REDACTED_GEMINI_KEY]')
    .replace(/("refresh_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[REDACTED]')
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) {
        return a.stack || `${a.name}: ${a.message}`
      }
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

export class BackendLogger {
  readonly logsDir: string
  readonly logFilePath: string
  readonly serviceLogPath: string
  readonly debugEnabled: boolean
  private readonly ring: string[] = []
  private consoleHooked = false

  constructor(options: { logsDir: string; debugEnabled?: boolean }) {
    this.logsDir = path.resolve(options.logsDir)
    fs.mkdirSync(this.logsDir, { recursive: true })
    this.logFilePath = path.join(this.logsDir, 'ringwatch-backend.log')
    this.serviceLogPath = path.join(this.logsDir, 'ringwatch-service.log')
    this.debugEnabled = Boolean(options.debugEnabled)
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.logFilePath)) return
      const stat = fs.statSync(this.logFilePath)
      if (stat.size < MAX_LOG_BYTES) return

      for (let i = MAX_ARCHIVES; i >= 1; i--) {
        const src =
          i === 1
            ? this.logFilePath
            : path.join(this.logsDir, `ringwatch-backend.${i - 1}.log`)
        const dst = path.join(this.logsDir, `ringwatch-backend.${i}.log`)
        if (fs.existsSync(src)) {
          try {
            fs.renameSync(src, dst)
          } catch {
            // Ignore Windows lock during rotation
          }
        }
      }
    } catch {
      // Ignore rotation failures
    }
  }

  write(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string): void {
    if (level === 'DEBUG' && !this.debugEnabled) return
    const safe = sanitizeLogText(message).replace(/\r?\n/g, ' | ')
    const line = `[${new Date().toISOString()}] [${level}] ${safe}`
    this.ring.push(line)
    if (this.ring.length > MEMORY_RING_LIMIT) {
      this.ring.splice(0, this.ring.length - MEMORY_RING_LIMIT)
    }
    try {
      this.rotateIfNeeded()
      fs.appendFileSync(this.logFilePath, `${line}${os.EOL}`, 'utf-8')
    } catch {
      // Never crash app over log disk I/O
    }
  }

  info(message: string): void {
    this.write('INFO', message)
  }

  warn(message: string): void {
    this.write('WARN', message)
  }

  error(message: string): void {
    this.write('ERROR', message)
  }

  debug(message: string): void {
    this.write('DEBUG', message)
  }

  installConsoleCapture(): void {
    if (this.consoleHooked) return
    this.consoleHooked = true

    const origLog = console.log.bind(console)
    const origWarn = console.warn.bind(console)
    const origError = console.error.bind(console)

    console.log = (...args: unknown[]) => {
      this.write('INFO', formatArgs(args))
      origLog(...args)
    }
    console.warn = (...args: unknown[]) => {
      this.write('WARN', formatArgs(args))
      origWarn(...args)
    }
    console.error = (...args: unknown[]) => {
      this.write('ERROR', formatArgs(args))
      origError(...args)
    }
  }

  readRecentLines(maxLines = 400): string[] {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const raw = fs.readFileSync(this.logFilePath, 'utf-8')
        const lines = raw.split(/\r?\n/).filter(Boolean)
        return lines.slice(-maxLines)
      }
    } catch {
      // Fall back to in-memory ring
    }
    return this.ring.slice(-maxLines)
  }

  readServiceLogTail(maxLines = 250): string[] {
    try {
      if (fs.existsSync(this.serviceLogPath)) {
        const raw = fs.readFileSync(this.serviceLogPath, 'utf-8')
        const lines = raw.split(/\r?\n/).filter(Boolean)
        return lines.slice(-maxLines).map(sanitizeLogText)
      }
    } catch {
      // Optional service wrapper log
    }
    return []
  }

  buildTroubleshootingReport(summary: Record<string, unknown>): string {
    const sections: string[] = [
      '======================================================================',
      '  RingWatch NVR & AI Backend — Troubleshooting Diagnostic Report',
      `  Generated : ${new Date().toISOString()}`,
      `  Platform  : ${process.platform} ${process.arch} (Node ${process.version})`,
      `  Hostname  : ${os.hostname()}`,
      `  Logs Dir  : ${this.logsDir}`,
      `  Debug Mode: ${this.debugEnabled ? 'ON' : 'OFF'}`,
      '======================================================================',
      '',
      '--- SYSTEM & NVR DIAGNOSTICS ---',
      sanitizeLogText(JSON.stringify(summary, null, 2)),
      '',
      '--- RECENT BACKEND LOGS (ringwatch-backend.log) ---',
      ...this.readRecentLines(600),
    ]

    const svcLines = this.readServiceLogTail(250)
    if (svcLines.length > 0) {
      sections.push(
        '',
        '--- WINDOWS SERVICE WRAPPER LOGS (ringwatch-service.log) ---',
        ...svcLines,
      )
    }

    sections.push('')
    return sections.join('\r\n')
  }
}
