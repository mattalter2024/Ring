import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import tls from 'node:tls'
import type { TlsStatus } from '../../shared/types'
import type { ConfigStore } from './configStore'

export interface TlsKeyMaterial {
  cert: string
  key: string
  ca?: string
}

interface SelfSignedMeta {
  dnsNames: string[]
  ipAddresses: string[]
  renewedAt: string
}

// ---------------------------------------------------------------------------
// Minimal RFC 5280 ASN.1 DER encoder (zero external dependencies)
// ---------------------------------------------------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length])
  }
  const bytes: number[] = []
  let n = length
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function derSequence(items: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items))
}

function derSet(items: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(items))
}

function derInteger(buf: Buffer): Buffer {
  // Trim leading redundant zeros while keeping at least 1 byte
  let start = 0
  while (start < buf.length - 1 && buf[start] === 0) {
    start++
  }
  let slice = buf.subarray(start)
  // Prefix 0x00 so ASN.1 treats high-bit values as positive integers
  if (slice[0] & 0x80) {
    slice = Buffer.concat([Buffer.from([0x00]), slice])
  }
  return derTag(0x02, slice)
}

function derSmallInt(val: number): Buffer {
  return derInteger(Buffer.from([val]))
}

function derBoolean(val: boolean): Buffer {
  return derTag(0x01, Buffer.from([val ? 0xff : 0x00]))
}

function derBitString(buf: Buffer, unusedBits = 0): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]))
}

function derOctetString(buf: Buffer): Buffer {
  return derTag(0x04, buf)
}

function derUtf8String(value: string): Buffer {
  return derTag(0x0c, Buffer.from(value, 'utf-8'))
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map((p) => Number(p))
  if (parts.length < 2) throw new Error(`Invalid OID: ${oid}`)
  const out: number[] = [parts[0] * 40 + parts[1]]
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]
    const sub: number[] = [v & 0x7f]
    v >>>= 7
    while (v > 0) {
      sub.unshift((v & 0x7f) | 0x80)
      v >>>= 7
    }
    out.push(...sub)
  }
  return derTag(0x06, Buffer.from(out))
}

function derTime(date: Date): Buffer {
  const year = date.getUTCFullYear()
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const mm = pad2(date.getUTCMonth() + 1)
  const dd = pad2(date.getUTCDate())
  const hh = pad2(date.getUTCHours())
  const min = pad2(date.getUTCMinutes())
  const ss = pad2(date.getUTCSeconds())
  if (year >= 1950 && year < 2050) {
    const yy = pad2(year % 100)
    return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${min}${ss}Z`, 'ascii'))
  }
  return derTag(0x18, Buffer.from(`${year}${mm}${dd}${hh}${min}${ss}Z`, 'ascii'))
}

function derExplicit(tagNum: number, content: Buffer): Buffer {
  return derTag(0xa0 | tagNum, content)
}

function encodeIpToBytes(ip: string): Buffer | null {
  const version = net.isIP(ip)
  if (version === 4) {
    const parts = ip.split('.').map((p) => Number(p))
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return null
    }
    return Buffer.from(parts)
  }
  if (version === 6) {
    // Expand :: shorthand into 8 16-bit groups
    const clean = ip.toLowerCase().split('%')[0]
    const halves = clean.split('::')
    if (halves.length > 2) return null
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
    const missing = 8 - (left.length + right.length)
    if (missing < 0) return null
    const groups = [
      ...left,
      ...Array.from({ length: missing }, () => '0'),
      ...right,
    ]
    if (groups.length !== 8) return null
    const buf = Buffer.alloc(16)
    for (let i = 0; i < 8; i++) {
      const val = parseInt(groups[i], 16)
      if (!Number.isFinite(val) || val < 0 || val > 0xffff) return null
      buf.writeUInt16BE(val, i * 2)
    }
    return buf
  }
  return null
}

function derExtension(oid: string, valueDer: Buffer, critical = false): Buffer {
  const items: Buffer[] = [derOid(oid)]
  if (critical) items.push(derBoolean(true))
  items.push(derOctetString(valueDer))
  return derSequence(items)
}

function derToPem(label: string, der: Buffer): string {
  const b64 = der.toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

export function generateSelfSignedX509Cert(options: {
  commonName?: string
  dnsNames: string[]
  ipAddresses: string[]
  validityDays?: number
  notBefore?: Date
}): { certPem: string; keyPem: string } {
  const validityDays = Math.max(1, Math.min(397, Math.round(options.validityDays ?? 365)))
  const commonName = (options.commonName?.trim() || 'localhost').slice(0, 64)

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

  const serial = crypto.randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 0x01 // strictly positive non-zero 128-bit serial

  // ecdsa-with-SHA256 (1.2.840.10045.4.3.2)
  const sigAlg = derSequence([derOid('1.2.840.10045.4.3.2')])

  const name = derSequence([
    derSet([derSequence([derOid('2.5.4.3'), derUtf8String(commonName)])]),
    derSet([derSequence([derOid('2.5.4.10'), derUtf8String('RingWatch Local NVR')])]),
  ])

  const now = options.notBefore ?? new Date(Date.now() - 5 * 60 * 1000)
  const notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000)
  const validity = derSequence([derTime(now), derTime(notAfter)])

  // Build Subject Alternative Names extension (2.5.29.17)
  const sanEntries: Buffer[] = []
  const seenDns = new Set<string>()
  for (const rawDns of options.dnsNames) {
    const dns = rawDns.trim().toLowerCase()
    if (!dns || net.isIP(dns) !== 0 || seenDns.has(dns)) continue
    seenDns.add(dns)
    // GeneralName dNSName [2] IMPLICIT IA5String -> tag 0x82
    sanEntries.push(derTag(0x82, Buffer.from(dns, 'ascii')))
  }
  const seenIp = new Set<string>()
  for (const rawIp of options.ipAddresses) {
    const ip = rawIp.trim()
    if (!ip || seenIp.has(ip)) continue
    const ipBytes = encodeIpToBytes(ip)
    if (!ipBytes) continue
    seenIp.add(ip)
    // GeneralName iPAddress [7] IMPLICIT OCTET STRING -> tag 0x87
    sanEntries.push(derTag(0x87, ipBytes))
  }

  const extensionsList: Buffer[] = [
    // BasicConstraints (2.5.29.19, critical): CA=FALSE
    derExtension('2.5.29.19', derSequence([]), true),
    // KeyUsage (2.5.29.15, critical): digitalSignature (bit 0) + keyEncipherment (bit 2) = 0xA0 (5 unused bits)
    derExtension('2.5.29.15', derBitString(Buffer.from([0xa0]), 5), true),
    // ExtendedKeyUsage (2.5.29.37): id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
    derExtension('2.5.29.37', derSequence([derOid('1.3.6.1.5.5.7.3.1')]), false),
  ]
  if (sanEntries.length > 0) {
    extensionsList.push(derExtension('2.5.29.17', derSequence(sanEntries), false))
  }

  const tbsCertificate = derSequence([
    derExplicit(0, derSmallInt(2)), // X.509 v3
    derInteger(serial),
    sigAlg,
    name, // issuer
    validity,
    name, // subject (self-signed)
    spkiDer,
    derExplicit(3, derSequence(extensionsList)),
  ])

  const signature = crypto.sign('sha256', tbsCertificate, privateKey)
  const fullCertDer = derSequence([tbsCertificate, sigAlg, derBitString(signature)])
  const certPem = derToPem('CERTIFICATE', fullCertDer)

  return { certPem, keyPem }
}

export function listCurrentHostSans(customHostnames: string[] = []): {
  dnsNames: string[]
  ipAddresses: string[]
} {
  const dnsSet = new Set<string>(['localhost'])
  const ipSet = new Set<string>(['127.0.0.1', '::1'])

  try {
    const rawHost = os.hostname().trim().toLowerCase()
    if (rawHost && /^[a-z0-9.-]+$/.test(rawHost) && net.isIP(rawHost) === 0) {
      dnsSet.add(rawHost)
      if (!rawHost.endsWith('.local')) {
        dnsSet.add(`${rawHost}.local`)
      }
    }
  } catch {
    // Ignore hostname lookup errors
  }

  try {
    const nets = os.networkInterfaces()
    for (const entries of Object.values(nets)) {
      for (const addr of entries ?? []) {
        if (addr.family === 'IPv4' && !addr.internal && addr.address) {
          ipSet.add(addr.address)
        }
      }
    }
  } catch {
    // Ignore network interface lookup errors
  }

  for (const raw of customHostnames) {
    const item = raw.trim().toLowerCase()
    if (!item) continue
    if (net.isIP(item) !== 0) {
      ipSet.add(item)
    } else if (/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(item)) {
      dnsSet.add(item)
    }
  }

  return {
    dnsNames: Array.from(dnsSet).sort(),
    ipAddresses: Array.from(ipSet).sort(),
  }
}

export function parseX509Metadata(certPem: string): {
  subject: string
  issuer: string
  validFrom: string
  validTo: string
  daysRemaining: number
  fingerprint256: string
  subjectAltNames: string[]
} {
  const x509 = new crypto.X509Certificate(certPem)
  const validToMs = new Date(x509.validTo).getTime()
  const daysRemaining = Math.floor((validToMs - Date.now()) / (24 * 60 * 60 * 1000))
  const subjectAltNames = (x509.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    subject: x509.subject.replace(/\n/g, ', '),
    issuer: x509.issuer.replace(/\n/g, ', '),
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: new Date(x509.validTo).toISOString(),
    daysRemaining,
    fingerprint256: x509.fingerprint256,
    subjectAltNames,
  }
}

export function validateTlsCertAndKey(
  certPem: string,
  keyPem: string,
  caPem?: string,
): ReturnType<typeof parseX509Metadata> {
  const cleanCert = certPem.trim()
  const cleanKey = keyPem.trim()
  const cleanCa = caPem?.trim() || undefined

  if (!cleanCert.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Certificate must be in valid PEM format (-----BEGIN CERTIFICATE-----).')
  }
  if (!cleanKey.includes('-----BEGIN ') || !cleanKey.includes('PRIVATE KEY-----')) {
    throw new Error('Private key must be in valid PEM format (-----BEGIN ... PRIVATE KEY-----).')
  }

  const meta = parseX509Metadata(cleanCert)
  const validToMs = new Date(meta.validTo).getTime()
  if (!Number.isFinite(validToMs) || validToMs <= Date.now()) {
    throw new Error(`Certificate expired on ${meta.validTo}. Provide a valid non-expired certificate.`)
  }

  // Let Node/OpenSSL verify the private key matches the public key in the certificate
  try {
    tls.createSecureContext({
      cert: cleanCert,
      key: cleanKey,
      ca: cleanCa,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Certificate and private key validation failed: ${msg}`)
  }

  return meta
}

function hashKeyMaterial(material: TlsKeyMaterial): string {
  return crypto
    .createHash('sha256')
    .update(material.cert)
    .update('\n')
    .update(material.key)
    .update('\n')
    .update(material.ca ?? '')
    .digest('hex')
}

export class TlsCertService {
  private readonly certsDir: string
  private readonly selfSignedCertPath: string
  private readonly selfSignedKeyPath: string
  private readonly selfSignedMetaPath: string
  private readonly customCertPath: string
  private readonly customKeyPath: string
  private readonly customCaPath: string
  private readonly configStore: ConfigStore
  private readonly onMaterialUpdated?: (material: TlsKeyMaterial) => void
  private readonly envCertPath: string | null
  private readonly envKeyPath: string | null
  private readonly envCaPath: string | null

  private activeMaterial: TlsKeyMaterial | null = null
  private activeMaterialHash: string | null = null
  private activeCertSource: TlsStatus['certSource'] = 'none'
  private lastRenewedAt: string | null = null
  private lastError: string | null = null
  private renewalTimer: NodeJS.Timeout | null = null

  constructor(params: {
    dataDir: string
    configStore: ConfigStore
    onMaterialUpdated?: (material: TlsKeyMaterial) => void
    envCertPath?: string
    envKeyPath?: string
    envCaPath?: string
  }) {
    this.certsDir = path.join(params.dataDir, 'certs')
    fs.mkdirSync(this.certsDir, { recursive: true })
    this.selfSignedCertPath = path.join(this.certsDir, 'self-signed-cert.pem')
    this.selfSignedKeyPath = path.join(this.certsDir, 'self-signed-key.pem')
    this.selfSignedMetaPath = path.join(this.certsDir, 'self-signed-meta.json')
    this.customCertPath = path.join(this.certsDir, 'custom-cert.pem')
    this.customKeyPath = path.join(this.certsDir, 'custom-key.pem')
    this.customCaPath = path.join(this.certsDir, 'custom-ca.pem')
    this.configStore = params.configStore
    this.onMaterialUpdated = params.onMaterialUpdated
    this.envCertPath = params.envCertPath?.trim() || null
    this.envKeyPath = params.envKeyPath?.trim() || null
    this.envCaPath = params.envCaPath?.trim() || null
  }

  isManagedByEnv(): boolean {
    return Boolean(this.envCertPath && this.envKeyPath)
  }

  private writeAtomic(filePath: string, content: string, mode: number): void {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode })
    fs.renameSync(tmpPath, filePath)
    try {
      fs.chmodSync(filePath, mode)
    } catch {
      // chmod may be a no-op on Windows NTFS
    }
  }

  private readSelfSignedMeta(): SelfSignedMeta | null {
    if (!fs.existsSync(this.selfSignedMetaPath)) return null
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.selfSignedMetaPath, 'utf-8'),
      ) as Partial<SelfSignedMeta>
      if (Array.isArray(parsed.dnsNames) && Array.isArray(parsed.ipAddresses)) {
        return {
          dnsNames: parsed.dnsNames.map(String).sort(),
          ipAddresses: parsed.ipAddresses.map(String).sort(),
          renewedAt: typeof parsed.renewedAt === 'string' ? parsed.renewedAt : new Date().toISOString(),
        }
      }
      return null
    } catch {
      return null
    }
  }

  private generateAndSaveSelfSigned(customHostnames?: string[]): TlsKeyMaterial {
    const tlsCfg = this.configStore.getPublicSettings().tls
    const hostnames = customHostnames ?? tlsCfg.customHostnames
    const { dnsNames, ipAddresses } = listCurrentHostSans(hostnames)
    const commonName = hostnames[0] || dnsNames.find((d) => d !== 'localhost') || 'localhost'

    const { certPem, keyPem } = generateSelfSignedX509Cert({
      commonName,
      dnsNames,
      ipAddresses,
      validityDays: 365,
    })

    // Self-verify before persisting
    validateTlsCertAndKey(certPem, keyPem)

    const nowIso = new Date().toISOString()
    this.writeAtomic(this.selfSignedCertPath, certPem, 0o644)
    this.writeAtomic(this.selfSignedKeyPath, keyPem, 0o600)
    const meta: SelfSignedMeta = {
      dnsNames,
      ipAddresses,
      renewedAt: nowIso,
    }
    this.writeAtomic(this.selfSignedMetaPath, JSON.stringify(meta, null, 2), 0o644)
    this.lastRenewedAt = nowIso
    return { cert: certPem, key: keyPem }
  }

  private loadOrRenewSelfSigned(forceRenew = false): {
    material: TlsKeyMaterial
    renewed: boolean
  } {
    const tlsCfg = this.configStore.getPublicSettings().tls
    const desired = listCurrentHostSans(tlsCfg.customHostnames)

    if (
      !forceRenew &&
      fs.existsSync(this.selfSignedCertPath) &&
      fs.existsSync(this.selfSignedKeyPath)
    ) {
      try {
        const cert = fs.readFileSync(this.selfSignedCertPath, 'utf-8')
        const key = fs.readFileSync(this.selfSignedKeyPath, 'utf-8')
        const meta = validateTlsCertAndKey(cert, key)
        const storedMeta = this.readSelfSignedMeta()
        const dnsMatches =
          storedMeta !== null &&
          storedMeta.dnsNames.length === desired.dnsNames.length &&
          storedMeta.dnsNames.every((v, i) => v === desired.dnsNames[i])
        const ipMatches =
          storedMeta !== null &&
          storedMeta.ipAddresses.length === desired.ipAddresses.length &&
          storedMeta.ipAddresses.every((v, i) => v === desired.ipAddresses[i])

        if (
          meta.daysRemaining > tlsCfg.autoRenewDaysBeforeExpiry &&
          dnsMatches &&
          ipMatches
        ) {
          this.lastRenewedAt = storedMeta?.renewedAt ?? meta.validFrom
          return { material: { cert, key }, renewed: false }
        }
      } catch {
        // Existing self-signed cert invalid or expiring -> auto-renew below
      }
    }

    const fresh = this.generateAndSaveSelfSigned(tlsCfg.customHostnames)
    return { material: fresh, renewed: true }
  }

  private loadExternalFiles(
    certPath: string,
    keyPath: string,
    caPath?: string,
  ): TlsKeyMaterial {
    if (!certPath || !fs.existsSync(certPath)) {
      throw new Error(`TLS certificate file not found: ${certPath || '(empty path)'}`)
    }
    if (!keyPath || !fs.existsSync(keyPath)) {
      throw new Error(`TLS private key file not found: ${keyPath || '(empty path)'}`)
    }
    const cert = fs.readFileSync(certPath, 'utf-8')
    const key = fs.readFileSync(keyPath, 'utf-8')
    let ca: string | undefined
    if (caPath && caPath.trim()) {
      if (!fs.existsSync(caPath.trim())) {
        throw new Error(`TLS CA chain file not found: ${caPath.trim()}`)
      }
      ca = fs.readFileSync(caPath.trim(), 'utf-8')
    }
    validateTlsCertAndKey(cert, key, ca)
    return { cert, key, ca }
  }

  private loadUploadedCustomPem(): TlsKeyMaterial {
    return this.loadExternalFiles(
      this.customCertPath,
      this.customKeyPath,
      fs.existsSync(this.customCaPath) ? this.customCaPath : undefined,
    )
  }

  private commitMaterial(
    material: TlsKeyMaterial,
    source: TlsStatus['certSource'],
    notifyIfChanged: boolean,
  ): boolean {
    const nextHash = hashKeyMaterial(material)
    const changed = nextHash !== this.activeMaterialHash || source !== this.activeCertSource
    this.activeMaterial = material
    this.activeMaterialHash = nextHash
    this.activeCertSource = source
    this.lastError = null
    if (changed && notifyIfChanged) {
      this.onMaterialUpdated?.(material)
    }
    return changed
  }

  /**
   * Loads the configured certificate (or generates/auto-renews the self-signed cert).
   * Safe to call on startup and repeatedly on the background renewal timer.
   */
  ensureCertificate(options?: { notifyOnReload?: boolean }): {
    material: TlsKeyMaterial
    reloaded: boolean
  } {
    const notify = options?.notifyOnReload ?? false
    const tlsCfg = this.configStore.getPublicSettings().tls

    // 1. Environment-variable-managed external cert files (highest priority)
    if (this.envCertPath && this.envKeyPath) {
      try {
        const material = this.loadExternalFiles(
          this.envCertPath,
          this.envKeyPath,
          this.envCaPath ?? undefined,
        )
        const reloaded = this.commitMaterial(material, 'env-files', notify)
        if (reloaded) this.lastRenewedAt = new Date().toISOString()
        return { material, reloaded }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        if (this.activeMaterial) {
          return { material: this.activeMaterial, reloaded: false }
        }
        // Fall back to self-signed so HTTPS still starts even if env paths are temporarily missing
        const fallback = this.loadOrRenewSelfSigned()
        this.commitMaterial(fallback.material, 'self-signed', notify)
        return { material: fallback.material, reloaded: fallback.renewed }
      }
    }

    // 2. User-configured external file paths (Certbot / Let's Encrypt / win-acme / Tailscale)
    if (tlsCfg.mode === 'custom-files' && tlsCfg.customCertPath && tlsCfg.customKeyPath) {
      try {
        const material = this.loadExternalFiles(
          tlsCfg.customCertPath,
          tlsCfg.customKeyPath,
          tlsCfg.customCaPath || undefined,
        )
        const reloaded = this.commitMaterial(material, 'file-paths', notify)
        if (reloaded) this.lastRenewedAt = new Date().toISOString()
        return { material, reloaded }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        if (this.activeMaterial) {
          return { material: this.activeMaterial, reloaded: false }
        }
      }
    }

    // 3. User-uploaded PEM stored inside <dataDir>/certs/
    if (tlsCfg.mode === 'custom-pem') {
      try {
        const material = this.loadUploadedCustomPem()
        const reloaded = this.commitMaterial(material, 'uploaded-pem', notify)
        return { material, reloaded }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        if (this.activeMaterial) {
          return { material: this.activeMaterial, reloaded: false }
        }
      }
    }

    // 4. Default: auto-generated, auto-renewing self-signed X.509 v3 certificate
    const { material, renewed } = this.loadOrRenewSelfSigned(false)
    const reloaded = this.commitMaterial(material, 'self-signed', notify)
    return { material, reloaded: reloaded || renewed }
  }

  /**
   * Starts periodic auto-renewal checks (default every 12 hours):
   * - Self-signed mode: auto-renews when approaching expiry or when LAN IP / SAN hostnames change.
   * - Custom file paths / env paths: auto-hot-reloads when Certbot / ACME replaces files on disk.
   */
  startAutoRenewal(intervalMs = 12 * 60 * 60 * 1000): void {
    this.stopAutoRenewal()
    if (intervalMs <= 0) return
    this.renewalTimer = setInterval(() => {
      try {
        const { reloaded } = this.ensureCertificate({ notifyOnReload: true })
        if (reloaded) {
          console.log(
            `[RingWatch TLS] Automatically reloaded ${this.activeCertSource} HTTPS certificate with zero downtime.`,
          )
        }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        console.warn('[RingWatch TLS] Auto-renewal check warning:', this.lastError)
      }
    }, intervalMs)
    if (typeof this.renewalTimer.unref === 'function') {
      this.renewalTimer.unref()
    }
  }

  stopAutoRenewal(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer)
      this.renewalTimer = null
    }
  }

  regenerateSelfSigned(customHostnames?: string[]): TlsKeyMaterial {
    if (this.isManagedByEnv()) {
      throw new Error(
        'TLS certificate is managed by RINGWATCH_TLS_CERT_PATH / RINGWATCH_TLS_KEY_PATH environment variables.',
      )
    }
    if (customHostnames !== undefined) {
      this.configStore.updateSettings({
        tls: { mode: 'self-signed', customHostnames },
      })
    } else {
      this.configStore.updateSettings({ tls: { mode: 'self-signed' } })
    }
    const material = this.generateAndSaveSelfSigned(customHostnames)
    this.commitMaterial(material, 'self-signed', true)
    return material
  }

  installCustomPem(params: {
    certPem: string
    keyPem: string
    caPem?: string
  }): TlsKeyMaterial {
    if (this.isManagedByEnv()) {
      throw new Error(
        'TLS certificate is managed by RINGWATCH_TLS_CERT_PATH / RINGWATCH_TLS_KEY_PATH environment variables.',
      )
    }
    const cert = params.certPem.trim() + '\n'
    const key = params.keyPem.trim() + '\n'
    const ca = params.caPem?.trim() ? params.caPem.trim() + '\n' : undefined

    validateTlsCertAndKey(cert, key, ca)

    this.writeAtomic(this.customCertPath, cert, 0o644)
    this.writeAtomic(this.customKeyPath, key, 0o600)
    if (ca) {
      this.writeAtomic(this.customCaPath, ca, 0o644)
    } else if (fs.existsSync(this.customCaPath)) {
      fs.unlinkSync(this.customCaPath)
    }

    this.configStore.setHasUploadedCustomCert(true)
    this.configStore.updateSettings({ tls: { mode: 'custom-pem' } })
    this.lastRenewedAt = new Date().toISOString()
    const material: TlsKeyMaterial = { cert, key, ca }
    this.commitMaterial(material, 'uploaded-pem', true)
    return material
  }

  useCustomCertFiles(params: {
    certPath: string
    keyPath: string
    caPath?: string
  }): TlsKeyMaterial {
    if (this.isManagedByEnv()) {
      throw new Error(
        'TLS certificate is managed by RINGWATCH_TLS_CERT_PATH / RINGWATCH_TLS_KEY_PATH environment variables.',
      )
    }
    const certPath = params.certPath.trim()
    const keyPath = params.keyPath.trim()
    const caPath = params.caPath?.trim() || ''

    const material = this.loadExternalFiles(certPath, keyPath, caPath || undefined)

    this.configStore.updateSettings({
      tls: {
        mode: 'custom-files',
        customCertPath: certPath,
        customKeyPath: keyPath,
        customCaPath: caPath,
      },
    })
    this.lastRenewedAt = new Date().toISOString()
    this.commitMaterial(material, 'file-paths', true)
    return material
  }

  switchToSelfSigned(): TlsKeyMaterial {
    if (this.isManagedByEnv()) {
      throw new Error(
        'TLS certificate is managed by RINGWATCH_TLS_CERT_PATH / RINGWATCH_TLS_KEY_PATH environment variables.',
      )
    }
    this.configStore.updateSettings({ tls: { mode: 'self-signed' } })
    const { material } = this.loadOrRenewSelfSigned(false)
    this.commitMaterial(material, 'self-signed', true)
    return material
  }

  getActiveMaterial(): TlsKeyMaterial | null {
    return this.activeMaterial
  }

  /**
   * Returns ONLY the public certificate PEM (never the private key) so users
   * can download and trust it on macOS Keychain, Windows, or mobile devices.
   */
  getActiveCertificatePem(): string | null {
    return this.activeMaterial?.cert ?? null
  }

  getStatus(runtime: {
    active: boolean
    boundHttpsPort: number | null
    bindError?: string | null
  }): TlsStatus {
    const tlsCfg = this.configStore.getPublicSettings().tls
    let meta: ReturnType<typeof parseX509Metadata> | null = null
    if (this.activeMaterial?.cert) {
      try {
        meta = parseX509Metadata(this.activeMaterial.cert)
      } catch {
        meta = null
      }
    }

    return {
      enabled: tlsCfg.enabled,
      active: runtime.active,
      httpsPort: runtime.boundHttpsPort ?? (tlsCfg.enabled ? tlsCfg.httpsPort : null),
      redirectHttpToHttps: tlsCfg.redirectHttpToHttps,
      mode: this.isManagedByEnv() ? 'custom-files' : tlsCfg.mode,
      managedByEnv: this.isManagedByEnv(),
      subject: meta?.subject ?? null,
      issuer: meta?.issuer ?? null,
      validFrom: meta?.validFrom ?? null,
      validTo: meta?.validTo ?? null,
      daysRemaining: meta?.daysRemaining ?? null,
      fingerprint256: meta?.fingerprint256 ?? null,
      subjectAltNames: meta?.subjectAltNames ?? [],
      autoRenewEnabled:
        this.activeCertSource === 'self-signed' ||
        this.activeCertSource === 'file-paths' ||
        this.activeCertSource === 'env-files',
      autoRenewDaysBeforeExpiry: tlsCfg.autoRenewDaysBeforeExpiry,
      lastRenewedAt: this.lastRenewedAt,
      certSource: this.activeCertSource,
      lastError: runtime.bindError ?? this.lastError,
    }
  }
}
