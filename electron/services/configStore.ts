import fs from 'node:fs'
import path from 'node:path'
import type {
  AppSettings,
  AppSettingsPatch,
  PackageAiConfig,
} from '../../shared/types'

interface StoredSecrets {
  ringRefreshToken?: string
  openaiApiKey?: string
  geminiApiKey?: string
}

interface PersistedConfigFile {
  mode: AppSettings['mode']
  recordingsDir: string
  defaultCaptureSeconds: number
  autoRecordOnMotion: boolean
  autoRecordOnDoorbell: boolean
  autoRecordOnPackage: boolean
  maxStorageGb: number
  retentionDays: number
  ffmpegPath: string
  minimizeToTray: boolean
  startMinimized: boolean
  packageAi: Omit<PackageAiConfig, 'hasOpenaiKey' | 'hasGeminiKey'>
  secretsPlain?: StoredSecrets
  secretsEncrypted?: Record<string, string>
}

export interface SecretCryptoAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

const DEFAULT_PACKAGE_AI: Omit<PackageAiConfig, 'hasOpenaiKey' | 'hasGeminiKey'> = {
  enabled: true,
  provider: 'openai',
  openaiModel: 'gpt-4o-mini',
  geminiModel: 'gemini-2.5-flash',
  monitoredCameraIds: [],
  triggerOnMotion: true,
  triggerOnDoorbell: true,
  intervalMinutes: 0,
  minConfidence: 0.65,
  cooldownMinutes: 5,
  desktopNotifications: true,
  alertSound: 'crisp-chime',
  alertVolume: 0.85,
  customPromptHint: '',
}

export class ConfigStore {
  private readonly configPath: string
  private readonly defaultRecordingsDir: string
  private readonly cryptoAdapter?: SecretCryptoAdapter
  private data: PersistedConfigFile
  private secrets: StoredSecrets = {}

  constructor(
    userDataDir: string,
    defaultRecordingsDir: string,
    cryptoAdapter?: SecretCryptoAdapter,
  ) {
    fs.mkdirSync(userDataDir, { recursive: true })
    this.configPath = path.join(userDataDir, 'ringwatch-config.json')
    this.defaultRecordingsDir = defaultRecordingsDir
    this.cryptoAdapter = cryptoAdapter
    this.data = this.loadFromDisk()
  }

  private getDefaultConfig(): PersistedConfigFile {
    return {
      mode: 'demo',
      recordingsDir: this.defaultRecordingsDir,
      defaultCaptureSeconds: 30,
      autoRecordOnMotion: true,
      autoRecordOnDoorbell: true,
      autoRecordOnPackage: true,
      maxStorageGb: 25,
      retentionDays: 30,
      ffmpegPath: '',
      minimizeToTray: true,
      startMinimized: false,
      packageAi: { ...DEFAULT_PACKAGE_AI },
    }
  }

  private loadFromDisk(): PersistedConfigFile {
    const defaults = this.getDefaultConfig()
    if (!fs.existsSync(this.configPath)) {
      return defaults
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<PersistedConfigFile>
      const merged: PersistedConfigFile = {
        ...defaults,
        ...parsed,
        packageAi: {
          ...DEFAULT_PACKAGE_AI,
          ...(parsed.packageAi ?? {}),
        },
      }
      this.secrets = this.readSecrets(parsed)
      return merged
    } catch {
      return defaults
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
      mode: this.data.mode,
      recordingsDir: this.data.recordingsDir,
      defaultCaptureSeconds: this.data.defaultCaptureSeconds,
      autoRecordOnMotion: this.data.autoRecordOnMotion,
      autoRecordOnDoorbell: this.data.autoRecordOnDoorbell,
      autoRecordOnPackage: this.data.autoRecordOnPackage,
      maxStorageGb: this.data.maxStorageGb,
      retentionDays: this.data.retentionDays,
      ffmpegPath: this.data.ffmpegPath,
      minimizeToTray: this.data.minimizeToTray,
      startMinimized: this.data.startMinimized,
      packageAi: this.data.packageAi,
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

    fs.writeFileSync(this.configPath, JSON.stringify(payload, null, 2), 'utf-8')
  }

  getPublicSettings(): AppSettings {
    return {
      mode: this.data.mode,
      recordingsDir: this.data.recordingsDir,
      defaultCaptureSeconds: this.data.defaultCaptureSeconds,
      autoRecordOnMotion: this.data.autoRecordOnMotion,
      autoRecordOnDoorbell: this.data.autoRecordOnDoorbell,
      autoRecordOnPackage: this.data.autoRecordOnPackage,
      maxStorageGb: this.data.maxStorageGb,
      retentionDays: this.data.retentionDays,
      ffmpegPath: this.data.ffmpegPath,
      minimizeToTray: this.data.minimizeToTray,
      startMinimized: this.data.startMinimized,
      hasRingToken: Boolean(this.secrets.ringRefreshToken),
      packageAi: {
        ...this.data.packageAi,
        hasOpenaiKey: Boolean(this.secrets.openaiApiKey),
        hasGeminiKey: Boolean(this.secrets.geminiApiKey),
      },
    }
  }

  updateSettings(patch: AppSettingsPatch): AppSettings {
    if (patch.mode !== undefined) this.data.mode = patch.mode
    if (patch.recordingsDir !== undefined && patch.recordingsDir.trim()) {
      this.data.recordingsDir = patch.recordingsDir.trim()
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
    if (patch.maxStorageGb !== undefined) {
      this.data.maxStorageGb = Math.max(0, Math.min(2000, patch.maxStorageGb))
    }
    if (patch.retentionDays !== undefined) {
      this.data.retentionDays = Math.max(0, Math.min(365, Math.round(patch.retentionDays)))
    }
    if (patch.ffmpegPath !== undefined) this.data.ffmpegPath = patch.ffmpegPath.trim()
    if (patch.minimizeToTray !== undefined) this.data.minimizeToTray = patch.minimizeToTray
    if (patch.startMinimized !== undefined) this.data.startMinimized = patch.startMinimized

    if (patch.packageAi) {
      const ai = patch.packageAi
      if (ai.enabled !== undefined) this.data.packageAi.enabled = ai.enabled
      if (ai.provider !== undefined) this.data.packageAi.provider = ai.provider
      if (ai.openaiModel !== undefined) this.data.packageAi.openaiModel = ai.openaiModel
      if (ai.geminiModel !== undefined) this.data.packageAi.geminiModel = ai.geminiModel
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

    this.persist()
    return this.getPublicSettings()
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
}
