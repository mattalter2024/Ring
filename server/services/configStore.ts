import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  AppSettings,
  AppSettingsPatch,
  PackageAiConfig,
  TlsConfig,
} from '../../shared/types'

interface StoredSecrets {
  ringRefreshToken?: string
  openaiApiKey?: string
  geminiApiKey?: string
  authPasswordHash?: string
}

const CURRENT_CONFIG_VERSION = 3

interface PersistedConfigFile {
  configVersion?: number
  mode: AppSettings['mode']
  ringSystemId?: string
  recordingsDir: string
  failoverRecordingsDir: string
  organizeByDateFolder: boolean
  defaultCaptureSeconds: number
  autoRecordOnMotion: boolean
  autoRecordOnDoorbell: boolean
  autoRecordOnPackage: boolean
  continuousSegmentSeconds: number
  continuousSkipBatteryCams: boolean
  continuousAutoStart: boolean
  continuousCameraIds: string[]
  maxStorageGb: number
  retentionDays: number
  lowDiskWarningGb: number
  minFreeDiskGb: number
  nvrNotificationsEnabled: boolean
  preventSleepWhileRecording: boolean
  launchAtLogin: boolean
  ffmpegPath: string
  minimizeToTray: boolean
  startMinimized: boolean
  packageAi: Omit<PackageAiConfig, 'hasOpenaiKey' | 'hasGeminiKey'>
  tls: Omit<TlsConfig, 'hasUploadedCustomCert'>
  secretsPlain?: StoredSecrets
  secretsEncrypted?: Record<string, string>
}

export interface SecretCryptoAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview'

const DEPRECATED_GEMINI_MODELS: Record<string, string> = {
  'gemini-2.5-pro': 'gemini-3.1-pro-preview',
  'gemini-2.5-pro-preview-06-05': 'gemini-3.1-pro-preview',
  'gemini-2.5-pro-preview-05-06': 'gemini-3.1-pro-preview',
  'gemini-2.5-flash': 'gemini-3-flash-preview',
  'gemini-2.5-flash-preview-09-2025': 'gemini-3-flash-preview',
  'gemini-2.0-flash': 'gemini-3-flash-preview',
  'gemini-2.0-flash-exp': 'gemini-3-flash-preview',
  'gemini-1.5-pro': 'gemini-3.1-pro-preview',
  'gemini-1.5-flash': 'gemini-3-flash-preview',
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite-preview': 'gemini-3-flash-preview',
}

export function normalizeGeminiModel(model?: string): string {
  const cleaned = (model ?? '').trim().replace(/^models\//i, '')
  if (!cleaned) return DEFAULT_GEMINI_MODEL
  return DEPRECATED_GEMINI_MODELS[cleaned.toLowerCase()] ?? cleaned
}

const DEFAULT_PACKAGE_AI: Omit<PackageAiConfig, 'hasOpenaiKey' | 'hasGeminiKey'> = {
  enabled: true,
  provider: 'openai',
  openaiModel: 'gpt-4o-mini',
  geminiModel: DEFAULT_GEMINI_MODEL,
  monitoredCameraIds: [],
  triggerOnMotion: true,
  triggerOnDoorbell: true,
  intervalMinutes: 0,
  minConfidence: 0.5,
  cooldownMinutes: 5,
  desktopNotifications: true,
  alertSound: 'crisp-chime',
  alertVolume: 0.85,
  customPromptHint: '',
  scanQualityMode: 'balanced',
  requirePersistentChange: true,
  personOrPackageEventsOnly: true,
  minScanIntervalSeconds: 90,
  pauseWhilePackagePresent: true,
  dailyScanLimit: 60,
  activeHoursEnabled: false,
  activeHoursStart: 6,
  activeHoursEnd: 22,
}

const DEFAULT_TLS: Omit<TlsConfig, 'hasUploadedCustomCert'> = {
  enabled: true,
  httpsPort: 3443,
  redirectHttpToHttps: false,
  mode: 'self-signed',
  autoRenewDaysBeforeExpiry: 30,
  customHostnames: [],
  customCertPath: '',
  customKeyPath: '',
  customCaPath: '',
}

export class ConfigStore {
  private readonly userDataDir: string
  private readonly configPath: string
  private readonly defaultRecordingsDir: string
  private readonly cryptoAdapter?: SecretCryptoAdapter
  private data: PersistedConfigFile
  private secrets: StoredSecrets = {}
  private cachedHasUploadedCustomCert = false

  constructor(
    userDataDir: string,
    defaultRecordingsDir: string,
    cryptoAdapter?: SecretCryptoAdapter,
  ) {
    fs.mkdirSync(userDataDir, { recursive: true })
    this.userDataDir = userDataDir
    this.configPath = path.join(userDataDir, 'ringwatch-config.json')
    this.defaultRecordingsDir = defaultRecordingsDir
    this.cryptoAdapter = cryptoAdapter
    this.cachedHasUploadedCustomCert = this.checkUploadedCustomCertFiles()
    const { config, migrated } = this.loadFromDisk()
    this.data = config
    if (migrated) {
      this.persist()
    }
  }

  private checkUploadedCustomCertFiles(): boolean {
    const certsDir = path.join(this.userDataDir, 'certs')
    return (
      fs.existsSync(path.join(certsDir, 'custom-cert.pem')) &&
      fs.existsSync(path.join(certsDir, 'custom-key.pem'))
    )
  }

  setHasUploadedCustomCert(present: boolean): void {
    this.cachedHasUploadedCustomCert = present
  }

  getDefaultRecordingsDir(): string {
    return this.defaultRecordingsDir
  }

  private getDefaultConfig(): PersistedConfigFile {
    return {
      configVersion: CURRENT_CONFIG_VERSION,
      mode: 'demo',
      recordingsDir: this.defaultRecordingsDir,
      failoverRecordingsDir: '',
      organizeByDateFolder: true,
      defaultCaptureSeconds: 30,
      autoRecordOnMotion: true,
      autoRecordOnDoorbell: true,
      autoRecordOnPackage: true,
      continuousSegmentSeconds: 120,
      continuousSkipBatteryCams: false,
      continuousAutoStart: true,
      continuousCameraIds: [],
      maxStorageGb: 100,
      retentionDays: 30,
      lowDiskWarningGb: 20,
      minFreeDiskGb: 10,
      nvrNotificationsEnabled: true,
      preventSleepWhileRecording: true,
      launchAtLogin: true,
      ffmpegPath: '',
      minimizeToTray: true,
      startMinimized: false,
      packageAi: { ...DEFAULT_PACKAGE_AI },
      tls: { ...DEFAULT_TLS, customHostnames: [] },
    }
  }

  private loadFromDisk(): { config: PersistedConfigFile; migrated: boolean } {
    const defaults = this.getDefaultConfig()
    if (!fs.existsSync(this.configPath)) {
      return { config: defaults, migrated: false }
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<PersistedConfigFile>
      const priorVersion = typeof parsed.configVersion === 'number' ? parsed.configVersion : 1

      const merged: PersistedConfigFile = {
        ...defaults,
        ...parsed,
        configVersion: CURRENT_CONFIG_VERSION,
        continuousCameraIds: Array.isArray(parsed.continuousCameraIds)
          ? parsed.continuousCameraIds
          : [],
        packageAi: {
          ...DEFAULT_PACKAGE_AI,
          ...(parsed.packageAi ?? {}),
          geminiModel: normalizeGeminiModel(parsed.packageAi?.geminiModel),
        },
        tls: {
          ...DEFAULT_TLS,
          ...(parsed.tls ?? {}),
          customHostnames: Array.isArray(parsed.tls?.customHostnames)
            ? parsed.tls.customHostnames
                .map((h) => String(h).trim())
                .filter(Boolean)
            : [],
        },
      }

      let migrated = false
      // One-time v1 -> v2 upgrade: turn on zero-touch 24/7 autonomous NVR recording
      // and NVR protection defaults for existing installations upgrading to the UNVR build.
      if (priorVersion < 2) {
        merged.continuousAutoStart = true
        merged.preventSleepWhileRecording = true
        merged.nvrNotificationsEnabled = true
        merged.organizeByDateFolder = true
        if (parsed.launchAtLogin === undefined) {
          merged.launchAtLogin = true
        }
        migrated = true
      }

      // One-time v2 -> v3 upgrade: lower unmodified 0.65 confidence default to 0.50
      // so small/shadowed/plain delivery boxes aren't silently filtered out.
      if (priorVersion < 3) {
        if (
          parsed.packageAi?.minConfidence === undefined ||
          Math.abs(parsed.packageAi.minConfidence - 0.65) < 0.001
        ) {
          merged.packageAi.minConfidence = 0.5
        }
        migrated = true
      }

      if (merged.lowDiskWarningGb < merged.minFreeDiskGb) {
        merged.lowDiskWarningGb = merged.minFreeDiskGb
      }

      this.secrets = this.readSecrets(parsed)
      // If legacy plaintext secrets existed on disk and OS encryption is now available,
      // immediately re-persist so secretsPlain is removed and replaced with encrypted values.
      if (
        parsed.secretsPlain &&
        Object.keys(parsed.secretsPlain).length > 0 &&
        this.cryptoAdapter?.isEncryptionAvailable()
      ) {
        migrated = true
      }
      return { config: merged, migrated }
    } catch {
      return { config: defaults, migrated: false }
    }
  }

  private readSecrets(parsed: Partial<PersistedConfigFile>): StoredSecrets {
    const result: StoredSecrets = {}
    if (
      parsed.secretsEncrypted &&
      this.cryptoAdapter &&
      this.cryptoAdapter.isEncryptionAvailable()
    ) {
      for (const key of ['ringRefreshToken', 'openaiApiKey', 'geminiApiKey'] as const) {
        const enc = parsed.secretsEncrypted[key]
        if (enc) {
          try {
            result[key] = this.cryptoAdapter.decryptString(Buffer.from(enc, 'base64'))
          } catch {
            // Ignore unreadable secret from another machine profile
          }
        }
      }
    }
    if (parsed.secretsPlain) {
      for (const key of ['ringRefreshToken', 'openaiApiKey', 'geminiApiKey'] as const) {
        if (!result[key] && parsed.secretsPlain[key]) {
          result[key] = parsed.secretsPlain[key]
        }
      }
    }
    return result
  }

  private persist(): void {
    const payload: PersistedConfigFile = {
      configVersion: CURRENT_CONFIG_VERSION,
      mode: this.data.mode,
      ringSystemId: this.data.ringSystemId,
      recordingsDir: this.data.recordingsDir,
      failoverRecordingsDir: this.data.failoverRecordingsDir,
      organizeByDateFolder: this.data.organizeByDateFolder,
      defaultCaptureSeconds: this.data.defaultCaptureSeconds,
      autoRecordOnMotion: this.data.autoRecordOnMotion,
      autoRecordOnDoorbell: this.data.autoRecordOnDoorbell,
      autoRecordOnPackage: this.data.autoRecordOnPackage,
      continuousSegmentSeconds: this.data.continuousSegmentSeconds,
      continuousSkipBatteryCams: this.data.continuousSkipBatteryCams,
      continuousAutoStart: this.data.continuousAutoStart,
      continuousCameraIds: [...this.data.continuousCameraIds],
      maxStorageGb: this.data.maxStorageGb,
      retentionDays: this.data.retentionDays,
      lowDiskWarningGb: this.data.lowDiskWarningGb,
      minFreeDiskGb: this.data.minFreeDiskGb,
      nvrNotificationsEnabled: this.data.nvrNotificationsEnabled,
      preventSleepWhileRecording: this.data.preventSleepWhileRecording,
      launchAtLogin: this.data.launchAtLogin,
      ffmpegPath: this.data.ffmpegPath,
      minimizeToTray: this.data.minimizeToTray,
      startMinimized: this.data.startMinimized,
      packageAi: this.data.packageAi,
      tls: this.data.tls,
    }

    const canEncrypt = Boolean(
      this.cryptoAdapter && this.cryptoAdapter.isEncryptionAvailable(),
    )

    if (canEncrypt && this.cryptoAdapter) {
      const encMap: Record<string, string> = {}
      for (const key of ['ringRefreshToken', 'openaiApiKey', 'geminiApiKey'] as const) {
        const val = this.secrets[key]
        if (val) {
          encMap[key] = this.cryptoAdapter.encryptString(val).toString('base64')
        }
      }
      payload.secretsEncrypted = encMap
    } else {
      payload.secretsPlain = { ...this.secrets }
    }

    fs.writeFileSync(this.configPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  }

  getPublicSettings(): AppSettings {
    return {
      mode: this.data.mode,
      recordingsDir: this.data.recordingsDir,
      failoverRecordingsDir: this.data.failoverRecordingsDir,
      organizeByDateFolder: this.data.organizeByDateFolder,
      defaultCaptureSeconds: this.data.defaultCaptureSeconds,
      autoRecordOnMotion: this.data.autoRecordOnMotion,
      autoRecordOnDoorbell: this.data.autoRecordOnDoorbell,
      autoRecordOnPackage: this.data.autoRecordOnPackage,
      continuousSegmentSeconds: this.data.continuousSegmentSeconds,
      continuousSkipBatteryCams: this.data.continuousSkipBatteryCams,
      continuousAutoStart: this.data.continuousAutoStart,
      continuousCameraIds: [...this.data.continuousCameraIds],
      maxStorageGb: this.data.maxStorageGb,
      retentionDays: this.data.retentionDays,
      lowDiskWarningGb: this.data.lowDiskWarningGb,
      minFreeDiskGb: this.data.minFreeDiskGb,
      nvrNotificationsEnabled: this.data.nvrNotificationsEnabled,
      preventSleepWhileRecording: this.data.preventSleepWhileRecording,
      launchAtLogin: this.data.launchAtLogin,
      ffmpegPath: this.data.ffmpegPath,
      minimizeToTray: this.data.minimizeToTray,
      startMinimized: this.data.startMinimized,
      hasRingToken: Boolean(this.secrets.ringRefreshToken),
      packageAi: {
        ...this.data.packageAi,
        hasOpenaiKey: Boolean(this.secrets.openaiApiKey),
        hasGeminiKey: Boolean(this.secrets.geminiApiKey),
      },
      tls: {
        ...this.data.tls,
        customHostnames: [...this.data.tls.customHostnames],
        hasUploadedCustomCert: this.cachedHasUploadedCustomCert,
      },
    }
  }

  updateSettings(patch: AppSettingsPatch): AppSettings {
    if (patch.mode !== undefined) this.data.mode = patch.mode
    if (patch.recordingsDir !== undefined && patch.recordingsDir.trim()) {
      this.data.recordingsDir = patch.recordingsDir.trim()
    }
    if (patch.failoverRecordingsDir !== undefined) {
      this.data.failoverRecordingsDir = patch.failoverRecordingsDir.trim()
    }
    if (patch.organizeByDateFolder !== undefined) {
      this.data.organizeByDateFolder = patch.organizeByDateFolder
    }
    if (patch.defaultCaptureSeconds !== undefined) {
      this.data.defaultCaptureSeconds = Math.max(
        5,
        Math.min(300, Math.round(patch.defaultCaptureSeconds)),
      )
    }
    if (patch.autoRecordOnMotion !== undefined) {
      this.data.autoRecordOnMotion = patch.autoRecordOnMotion
    }
    if (patch.autoRecordOnDoorbell !== undefined) {
      this.data.autoRecordOnDoorbell = patch.autoRecordOnDoorbell
    }
    if (patch.autoRecordOnPackage !== undefined) {
      this.data.autoRecordOnPackage = patch.autoRecordOnPackage
    }
    if (patch.continuousSegmentSeconds !== undefined) {
      this.data.continuousSegmentSeconds = Math.max(
        30,
        Math.min(600, Math.round(patch.continuousSegmentSeconds)),
      )
    }
    if (patch.continuousSkipBatteryCams !== undefined) {
      this.data.continuousSkipBatteryCams = patch.continuousSkipBatteryCams
    }
    if (patch.continuousAutoStart !== undefined) {
      this.data.continuousAutoStart = patch.continuousAutoStart
    }
    if (patch.continuousCameraIds !== undefined) {
      this.data.continuousCameraIds = [...patch.continuousCameraIds]
    }
    if (patch.maxStorageGb !== undefined) {
      this.data.maxStorageGb = Math.max(0, Math.min(20000, patch.maxStorageGb))
    }
    if (patch.retentionDays !== undefined) {
      this.data.retentionDays = Math.max(0, Math.min(365, Math.round(patch.retentionDays)))
    }
    if (patch.minFreeDiskGb !== undefined) {
      this.data.minFreeDiskGb = Math.max(1, Math.min(250, Math.round(patch.minFreeDiskGb)))
    }
    if (patch.lowDiskWarningGb !== undefined) {
      this.data.lowDiskWarningGb = Math.max(
        2,
        Math.min(500, Math.round(patch.lowDiskWarningGb)),
      )
    }
    if (this.data.lowDiskWarningGb < this.data.minFreeDiskGb) {
      this.data.lowDiskWarningGb = this.data.minFreeDiskGb
    }
    if (patch.nvrNotificationsEnabled !== undefined) {
      this.data.nvrNotificationsEnabled = patch.nvrNotificationsEnabled
    }
    if (patch.preventSleepWhileRecording !== undefined) {
      this.data.preventSleepWhileRecording = patch.preventSleepWhileRecording
    }
    if (patch.launchAtLogin !== undefined) {
      this.data.launchAtLogin = patch.launchAtLogin
    }
    if (patch.ffmpegPath !== undefined) this.data.ffmpegPath = patch.ffmpegPath.trim()
    if (patch.minimizeToTray !== undefined) this.data.minimizeToTray = patch.minimizeToTray
    if (patch.startMinimized !== undefined) this.data.startMinimized = patch.startMinimized

    if (patch.packageAi) {
      const ai = patch.packageAi
      if (ai.enabled !== undefined) this.data.packageAi.enabled = ai.enabled
      if (ai.provider !== undefined) this.data.packageAi.provider = ai.provider
      if (ai.openaiModel !== undefined) this.data.packageAi.openaiModel = ai.openaiModel
      if (ai.geminiModel !== undefined) {
        this.data.packageAi.geminiModel = normalizeGeminiModel(ai.geminiModel)
      }
      if (ai.monitoredCameraIds !== undefined) {
        this.data.packageAi.monitoredCameraIds = [...ai.monitoredCameraIds]
      }
      if (ai.triggerOnMotion !== undefined) {
        this.data.packageAi.triggerOnMotion = ai.triggerOnMotion
      }
      if (ai.triggerOnDoorbell !== undefined) {
        this.data.packageAi.triggerOnDoorbell = ai.triggerOnDoorbell
      }
      if (ai.intervalMinutes !== undefined) {
        this.data.packageAi.intervalMinutes = Math.max(0, Math.min(120, ai.intervalMinutes))
      }
      if (ai.minConfidence !== undefined) {
        this.data.packageAi.minConfidence = Math.max(0.1, Math.min(0.99, ai.minConfidence))
      }
      if (ai.cooldownMinutes !== undefined) {
        this.data.packageAi.cooldownMinutes = Math.max(0, Math.min(120, ai.cooldownMinutes))
      }
      if (ai.desktopNotifications !== undefined) {
        this.data.packageAi.desktopNotifications = ai.desktopNotifications
      }
      if (ai.alertSound !== undefined) this.data.packageAi.alertSound = ai.alertSound
      if (ai.alertVolume !== undefined) {
        this.data.packageAi.alertVolume = Math.max(0, Math.min(1, ai.alertVolume))
      }
      if (ai.customPromptHint !== undefined) {
        this.data.packageAi.customPromptHint = ai.customPromptHint
      }
      if (
        ai.scanQualityMode === 'economy' ||
        ai.scanQualityMode === 'balanced' ||
        ai.scanQualityMode === 'high'
      ) {
        this.data.packageAi.scanQualityMode = ai.scanQualityMode
      }
      if (ai.requirePersistentChange !== undefined) {
        this.data.packageAi.requirePersistentChange = ai.requirePersistentChange
      }
      if (ai.personOrPackageEventsOnly !== undefined) {
        this.data.packageAi.personOrPackageEventsOnly = ai.personOrPackageEventsOnly
      }
      if (ai.minScanIntervalSeconds !== undefined) {
        this.data.packageAi.minScanIntervalSeconds = Math.max(
          0,
          Math.min(3600, Math.round(ai.minScanIntervalSeconds)),
        )
      }
      if (ai.pauseWhilePackagePresent !== undefined) {
        this.data.packageAi.pauseWhilePackagePresent = ai.pauseWhilePackagePresent
      }
      if (ai.dailyScanLimit !== undefined) {
        this.data.packageAi.dailyScanLimit = Math.max(
          0,
          Math.min(1000, Math.round(ai.dailyScanLimit)),
        )
      }
      if (ai.activeHoursEnabled !== undefined) {
        this.data.packageAi.activeHoursEnabled = ai.activeHoursEnabled
      }
      if (ai.activeHoursStart !== undefined) {
        this.data.packageAi.activeHoursStart = Math.max(
          0,
          Math.min(23, Math.round(ai.activeHoursStart)),
        )
      }
      if (ai.activeHoursEnd !== undefined) {
        this.data.packageAi.activeHoursEnd = Math.max(
          0,
          Math.min(23, Math.round(ai.activeHoursEnd)),
        )
      }
      if (ai.openaiApiKey !== undefined) {
        const trimmed = ai.openaiApiKey.trim()
        if (trimmed) this.secrets.openaiApiKey = trimmed
        else delete this.secrets.openaiApiKey
      }
      if (ai.geminiApiKey !== undefined) {
        const trimmed = ai.geminiApiKey.trim()
        if (trimmed) this.secrets.geminiApiKey = trimmed
        else delete this.secrets.geminiApiKey
      }
    }

    if (patch.tls) {
      const t = patch.tls
      if (t.enabled !== undefined) this.data.tls.enabled = t.enabled
      if (t.httpsPort !== undefined && Number.isFinite(t.httpsPort)) {
        this.data.tls.httpsPort = Math.max(1, Math.min(65535, Math.round(t.httpsPort)))
      }
      if (t.redirectHttpToHttps !== undefined) {
        this.data.tls.redirectHttpToHttps = t.redirectHttpToHttps
      }
      if (
        t.mode === 'self-signed' ||
        t.mode === 'custom-pem' ||
        t.mode === 'custom-files'
      ) {
        this.data.tls.mode = t.mode
      }
      if (t.autoRenewDaysBeforeExpiry !== undefined && Number.isFinite(t.autoRenewDaysBeforeExpiry)) {
        this.data.tls.autoRenewDaysBeforeExpiry = Math.max(
          1,
          Math.min(180, Math.round(t.autoRenewDaysBeforeExpiry)),
        )
      }
      if (Array.isArray(t.customHostnames)) {
        const cleaned = Array.from(
          new Set(
            t.customHostnames
              .map((h) => String(h).trim().toLowerCase())
              .filter((h) => h.length > 0 && h.length <= 253 && !/\s/.test(h)),
          ),
        )
        this.data.tls.customHostnames = cleaned
      }
      if (t.customCertPath !== undefined) {
        this.data.tls.customCertPath = t.customCertPath.trim()
      }
      if (t.customKeyPath !== undefined) {
        this.data.tls.customKeyPath = t.customKeyPath.trim()
      }
      if (t.customCaPath !== undefined) {
        this.data.tls.customCaPath = t.customCaPath.trim()
      }
    }

    this.persist()
    return this.getPublicSettings()
  }

  getRingSystemId(): string {
    if (!this.data.ringSystemId) {
      this.data.ringSystemId = crypto.randomUUID()
      this.persist()
    }
    return this.data.ringSystemId
  }

  getRingRefreshToken(): string | undefined {
    return this.secrets.ringRefreshToken
  }

  setRingRefreshToken(token: string | null): void {
    if (token && token.trim()) {
      this.secrets.ringRefreshToken = token.trim()
    } else {
      delete this.secrets.ringRefreshToken
    }
    this.persist()
  }

  getOpenaiApiKey(): string | undefined {
    return this.secrets.openaiApiKey
  }

  getGeminiApiKey(): string | undefined {
    return this.secrets.geminiApiKey
  }

  getAuthPasswordHash(): string | undefined {
    return this.secrets.authPasswordHash
  }

  setAuthPasswordHash(hash: string | null): void {
    if (hash && hash.trim()) {
      this.secrets.authPasswordHash = hash.trim()
    } else {
      delete this.secrets.authPasswordHash
    }
    this.persist()
  }
}
