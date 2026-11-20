import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SecretCryptoAdapter } from './configStore'

const KEY_FILE_NAME = '.ringwatch-secret.key'
const AES_ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Pure Node.js AES-256-GCM secret encryption adapter backed by a local 256-bit keyfile (mode 0o600).
 * Keeps Ring refresh tokens and OpenAI/Gemini API keys encrypted at rest in ringwatch-config.json
 * without requiring Electron or native desktop bindings.
 */
export class FileKeyCryptoAdapter implements SecretCryptoAdapter {
  private readonly key: Buffer

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    const keyPath = path.join(dataDir, KEY_FILE_NAME)
    this.key = this.loadOrCreateKey(keyPath)
  }

  private loadOrCreateKey(keyPath: string): Buffer {
    if (fs.existsSync(keyPath)) {
      try {
        const raw = fs.readFileSync(keyPath, 'utf-8').trim()
        const buf = Buffer.from(raw, 'hex')
        if (buf.length === 32) return buf
      } catch {
        // Regenerate if unreadable
      }
    }
    const fresh = crypto.randomBytes(32)
    fs.writeFileSync(keyPath, fresh.toString('hex'), { encoding: 'utf-8', mode: 0o600 })
    try {
      fs.chmodSync(keyPath, 0o600)
    } catch {
      // Ignore chmod errors on Windows NTFS
    }
    return fresh
  }

  isEncryptionAvailable(): boolean {
    return this.key.length === 32
  }

  encryptString(value: string): Buffer {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv(AES_ALGO, this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, encrypted])
  }

  decryptString(payload: Buffer): string {
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new Error('Encrypted secret payload is truncated')
    }
    const iv = payload.subarray(0, IV_BYTES)
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES)
    const decipher = crypto.createDecipheriv(AES_ALGO, this.key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString('utf-8')
  }

  /**
   * Derive a deterministic 32-byte HMAC signing key for HTTP-only web login session cookies.
   */
  getSessionSigningKey(): Buffer {
    return crypto.createHash('sha256').update('ringwatch-session-v1:').update(this.key).digest()
  }
}

/**
 * Hash a user-chosen web admin password using Node.js scrypt with a random 16-byte salt.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(password, salt, 32).toString('hex')
  return `scrypt$${salt}$${derived}`
}

/**
 * Timing-safe password verification against either a scrypt hash or a plain env-var password.
 */
export function verifyPassword(candidate: string, storedOrPlain: string): boolean {
  if (!candidate || !storedOrPlain) return false
  if (storedOrPlain.startsWith('scrypt$')) {
    const parts = storedOrPlain.split('$')
    if (parts.length !== 3) return false
    const [, salt, expectedHex] = parts
    const expected = Buffer.from(expectedHex, 'hex')
    const actual = crypto.scryptSync(candidate, salt, expected.length)
    if (actual.length !== expected.length) return false
    return crypto.timingSafeEqual(actual, expected)
  }
  const a = crypto.createHash('sha256').update(candidate, 'utf-8').digest()
  const b = crypto.createHash('sha256').update(storedOrPlain, 'utf-8').digest()
  return crypto.timingSafeEqual(a, b)
}

/**
 * Create a signed, expiring session cookie token (valid for 7 days by default).
 */
export function createSessionToken(
  signingKey: Buffer,
  ttlMs = 7 * 24 * 60 * 60 * 1000,
): string {
  const exp = Date.now() + ttlMs
  const nonce = crypto.randomBytes(12).toString('hex')
  const payload = `${exp}.${nonce}`
  const sig = crypto
    .createHmac('sha256', signingKey)
    .update(payload)
    .digest('base64url')
  return `${payload}.${sig}`
}

export function verifySessionToken(token: string | undefined, signingKey: Buffer): boolean {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [expStr, nonce, sig] = parts
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || Date.now() > exp || !nonce || !sig) return false
  const payload = `${expStr}.${nonce}`
  const expectedSig = crypto
    .createHmac('sha256', signingKey)
    .update(payload)
    .digest('base64url')
  const a = Buffer.from(sig, 'utf-8')
  const b = Buffer.from(expectedSig, 'utf-8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
