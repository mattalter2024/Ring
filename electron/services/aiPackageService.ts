import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  AiProvider,
  PackageDetectionRecord,
  SecurityEvent,
} from '../../shared/types'
import type { ConfigStore } from './configStore'
import type { NotificationService } from './notificationService'

export interface ParsedPackageVisionResult {
  packageDetected: boolean
  confidence: number
  packageCount: number
  carrierHint: string | null
  placement: string | null
  personPresent: boolean
  summary: string
}

const SYSTEM_PROMPT = `You are a precision home-security vision analyzer for Ring cameras.
Inspect the camera image and determine whether one or more delivered packages, parcels, cardboard shipping boxes, padded mailers, or grocery delivery bags are visibly present on the porch, doorstep, driveway, walkway, or patio.
Respond ONLY with a single valid JSON object matching this exact schema:
{
  "packageDetected": boolean,
  "confidence": number, // 0.0 to 1.0
  "packageCount": integer, // 0 if none
  "carrierHint": string | null, // e.g. "Amazon", "UPS", "FedEx", "USPS", "DHL", or null if unclear
  "placement": string | null, // concise location in frame, e.g. "On welcome mat beside front door"
  "personPresent": boolean,
  "summary": string // concise 1-sentence description for a Windows desktop notification
}`

export function parseVisionResponse(rawText: string): ParsedPackageVisionResult {
  const trimmed = rawText.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  const jsonSlice =
    firstBrace >= 0 && lastBrace > firstBrace
      ? candidate.slice(firstBrace, lastBrace + 1)
      : candidate

  const parsed = JSON.parse(jsonSlice) as Record<string, unknown>

  const packageDetected = Boolean(parsed.packageDetected)
  const rawConf =
    typeof parsed.confidence === 'number'
      ? parsed.confidence
      : Number(parsed.confidence ?? (packageDetected ? 0.75 : 0.9))
  const confidence = Number.isFinite(rawConf)
    ? Math.max(0, Math.min(1, rawConf > 1 ? rawConf / 100 : rawConf))
    : packageDetected
      ? 0.75
      : 0.9

  const rawCount =
    typeof parsed.packageCount === 'number'
      ? parsed.packageCount
      : Number(parsed.packageCount ?? (packageDetected ? 1 : 0))
  const packageCount = packageDetected
    ? Math.max(1, Number.isFinite(rawCount) ? Math.round(rawCount) : 1)
    : 0

  const carrierHint =
    typeof parsed.carrierHint === 'string' && parsed.carrierHint.trim()
      ? parsed.carrierHint.trim()
      : null

  const placement =
    typeof parsed.placement === 'string' && parsed.placement.trim()
      ? parsed.placement.trim()
      : null

  const personPresent = Boolean(parsed.personPresent)

  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : packageDetected
        ? `${packageCount} package${packageCount > 1 ? 's' : ''} detected in camera view.`
        : 'No delivery packages visible in frame.'

  return {
    packageDetected,
    confidence,
    packageCount,
    carrierHint,
    placement,
    personPresent,
    summary,
  }
}

export interface SnapshotSource {
  getCameraMeta(cameraId: string): { id: string; name: string } | undefined
  listCameraIds(): string[]
  captureSnapshotBase64(cameraId: string): Promise<{ base64: string; dataUrl: string }>
}

export class AiPackageService {
  private readonly historyPath: string
  private readonly configStore: ConfigStore
  private readonly notifications: NotificationService
  private readonly onDetection: (record: PackageDetectionRecord) => void
  private readonly onSecurityEvent: (event: SecurityEvent) => void
  private history: PackageDetectionRecord[] = []
  private readonly lastNotifiedAtByCamera = new Map<string, number>()
  private readonly inFlightCameras = new Set<string>()
  private schedulerTimer: NodeJS.Timeout | null = null
  private snapshotSource: SnapshotSource | null = null

  constructor(params: {
    userDataDir: string
    configStore: ConfigStore
    notifications: NotificationService
    onDetection: (record: PackageDetectionRecord) => void
    onSecurityEvent: (event: SecurityEvent) => void
  }) {
    this.historyPath = path.join(params.userDataDir, 'package-detections.json')
    this.configStore = params.configStore
    this.notifications = params.notifications
    this.onDetection = params.onDetection
    this.onSecurityEvent = params.onSecurityEvent
    this.history = this.loadHistory()
  }

  attachSnapshotSource(source: SnapshotSource): void {
    this.snapshotSource = source
    this.syncScheduler()
  }

  private loadHistory(): PackageDetectionRecord[] {
    if (!fs.existsSync(this.historyPath)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyPath, 'utf-8'))
      return Array.isArray(parsed) ? parsed.slice(0, 150) : []
    } catch {
      return []
    }
  }

  private saveHistory(): void {
    try {
      fs.writeFileSync(
        this.historyPath,
        JSON.stringify(this.history.slice(0, 150), null, 2),
        'utf-8',
      )
    } catch {
      // Ignore write failures
    }
  }

  listDetections(): PackageDetectionRecord[] {
    return [...this.history]
  }

  clearDetections(): void {
    this.history = []
    this.lastNotifiedAtByCamera.clear()
    this.saveHistory()
  }

  syncScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer)
      this.schedulerTimer = null
    }
    const ai = this.configStore.getPublicSettings().packageAi
    if (!ai.enabled || ai.intervalMinutes <= 0) return

    const ms = ai.intervalMinutes * 60 * 1000
    this.schedulerTimer = setInterval(() => {
      if (!this.snapshotSource) return
      const settings = this.configStore.getPublicSettings().packageAi
      if (!settings.enabled) return
      const allIds = this.snapshotSource.listCameraIds()
      const targets =
        settings.monitoredCameraIds.length > 0
          ? allIds.filter((id) => settings.monitoredCameraIds.includes(id))
          : allIds
      for (const camId of targets) {
        void this.scanCamera(camId, 'interval')
      }
    }, ms)
  }

  stop(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer)
      this.schedulerTimer = null
    }
  }

  shouldTriggerForCamera(
    cameraId: string,
    trigger: 'motion' | 'doorbell',
  ): boolean {
    const ai = this.configStore.getPublicSettings().packageAi
    if (!ai.enabled) return false
    if (trigger === 'motion' && !ai.triggerOnMotion) return false
    if (trigger === 'doorbell' && !ai.triggerOnDoorbell) return false
    if (
      ai.monitoredCameraIds.length > 0 &&
      !ai.monitoredCameraIds.includes(cameraId)
    ) {
      return false
    }
    return true
  }

  async handleAutoTrigger(
    cameraId: string,
    trigger: 'motion' | 'doorbell',
  ): Promise<PackageDetectionRecord | null> {
    if (!this.shouldTriggerForCamera(cameraId, trigger)) return null
    if (this.inFlightCameras.has(cameraId)) return null
    return this.scanCamera(cameraId, trigger)
  }

  async scanCamera(
    cameraId: string,
    trigger: PackageDetectionRecord['trigger'] = 'manual',
  ): Promise<PackageDetectionRecord> {
    if (!this.snapshotSource) {
      throw new Error('Camera snapshot source is not initialized')
    }
    const meta = this.snapshotSource.getCameraMeta(cameraId)
    if (!meta) {
      throw new Error(`Camera ${cameraId} not found`)
    }

    this.inFlightCameras.add(cameraId)
    const started = Date.now()
    const settings = this.configStore.getPublicSettings()
    const aiCfg = settings.packageAi

    try {
      const { base64, dataUrl } =
        await this.snapshotSource.captureSnapshotBase64(cameraId)

      const provider = aiCfg.provider
      const apiKey =
        provider === 'openai'
          ? this.configStore.getOpenaiApiKey()
          : this.configStore.getGeminiApiKey()

      let parsed: ParsedPackageVisionResult
      let usedProvider: AiProvider | 'demo-vision' = provider
      let usedModel =
        provider === 'openai' ? aiCfg.openaiModel : aiCfg.geminiModel

      if (apiKey) {
        parsed =
          provider === 'openai'
            ? await this.analyzeWithOpenAI(
                apiKey,
                aiCfg.openaiModel,
                base64,
                aiCfg.customPromptHint,
              )
            : await this.analyzeWithGemini(
                apiKey,
                aiCfg.geminiModel,
                base64,
                aiCfg.customPromptHint,
              )
      } else if (settings.mode === 'demo') {
        usedProvider = 'demo-vision'
        usedModel = 'demo-simulator'
        parsed = this.simulateDemoVision(cameraId, meta.name)
      } else {
        throw new Error(
          `No ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API key configured. Add your API key in Settings -> Cloud Vision AI.`,
        )
      }

      const latencyMs = Date.now() - started
      const meetsConfidence =
        parsed.packageDetected && parsed.confidence >= aiCfg.minConfidence
      const cooldownMs = aiCfg.cooldownMinutes * 60 * 1000
      const lastNotified = this.lastNotifiedAtByCamera.get(cameraId) ?? 0
      const cooldownPassed =
        trigger === 'manual' || Date.now() - lastNotified >= cooldownMs

      const shouldNotify = meetsConfidence && cooldownPassed

      const record: PackageDetectionRecord = {
        id: crypto.randomUUID(),
        cameraId,
        cameraName: meta.name,
        timestamp: new Date().toISOString(),
        provider: usedProvider,
        model: usedModel,
        trigger,
        packageDetected: parsed.packageDetected,
        confidence: parsed.confidence,
        packageCount: parsed.packageCount,
        carrierHint: parsed.carrierHint,
        placement: parsed.placement,
        personPresent: parsed.personPresent,
        summary: parsed.summary,
        snapshotDataUrl: dataUrl,
        notified: shouldNotify,
        latencyMs,
      }

      this.history.unshift(record)
      this.history = this.history.slice(0, 150)
      this.saveHistory()
      this.onDetection(record)

      if (shouldNotify) {
        this.lastNotifiedAtByCamera.set(cameraId, Date.now())
        const title = `Package Detected — ${meta.name}`
        const carrierPart = parsed.carrierHint ? ` (${parsed.carrierHint})` : ''
        const body = `${parsed.summary}${carrierPart} · ${Math.round(parsed.confidence * 100)}% confidence`

        this.notifications.notifyPackageAlert({
          title,
          body,
          cameraId,
          desktopEnabled: aiCfg.desktopNotifications,
          soundProfile: aiCfg.alertSound,
          volume: aiCfg.alertVolume,
        })

        this.onSecurityEvent({
          id: crypto.randomUUID(),
          timestamp: record.timestamp,
          sourceType: 'ai-package',
          deviceId: cameraId,
          deviceName: meta.name,
          kind: 'package-detected',
          title,
          detail: body,
          severity: 'alert',
          snapshotDataUrl: dataUrl,
        })
      }

      return record
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const record: PackageDetectionRecord = {
        id: crypto.randomUUID(),
        cameraId,
        cameraName: meta.name,
        timestamp: new Date().toISOString(),
        provider: aiCfg.provider,
        model:
          aiCfg.provider === 'openai' ? aiCfg.openaiModel : aiCfg.geminiModel,
        trigger,
        packageDetected: false,
        confidence: 0,
        packageCount: 0,
        carrierHint: null,
        placement: null,
        personPresent: false,
        summary: `Vision analysis failed: ${message}`,
        notified: false,
        latencyMs: Date.now() - started,
        rawError: message,
      }
      this.history.unshift(record)
      this.history = this.history.slice(0, 150)
      this.saveHistory()
      this.onDetection(record)
      return record
    } finally {
      this.inFlightCameras.delete(cameraId)
    }
  }

  async testConnection(): Promise<{
    ok: boolean
    message: string
    latencyMs?: number
  }> {
    const aiCfg = this.configStore.getPublicSettings().packageAi
    const provider = aiCfg.provider
    const apiKey =
      provider === 'openai'
        ? this.configStore.getOpenaiApiKey()
        : this.configStore.getGeminiApiKey()

    if (!apiKey) {
      return {
        ok: false,
        message: `Please save a ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API key first.`,
      }
    }

    const started = Date.now()
    try {
      if (provider === 'openai') {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        if (!res.ok) {
          const text = await res.text()
          return {
            ok: false,
            message: `OpenAI API returned HTTP ${res.status}: ${text.slice(0, 160)}`,
          }
        }
        return {
          ok: true,
          message: `OpenAI Vision ready (${aiCfg.openaiModel})`,
          latencyMs: Date.now() - started,
        }
      } else {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(aiCfg.geminiModel)}?key=${encodeURIComponent(apiKey)}`,
        )
        if (!res.ok) {
          const text = await res.text()
          return {
            ok: false,
            message: `Gemini API returned HTTP ${res.status}: ${text.slice(0, 160)}`,
          }
        }
        return {
          ok: true,
          message: `Google Gemini Vision ready (${aiCfg.geminiModel})`,
          latencyMs: Date.now() - started,
        }
      }
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  sendTestAlert(): void {
    const aiCfg = this.configStore.getPublicSettings().packageAi
    this.notifications.notifyPackageAlert({
      title: 'RingWatch Test Alert — Package Detected',
      body: 'Two cardboard delivery boxes detected on the Front Porch welcome mat (96% confidence).',
      desktopEnabled: aiCfg.desktopNotifications,
      soundProfile: aiCfg.alertSound,
      volume: aiCfg.alertVolume,
    })
  }

  private async analyzeWithOpenAI(
    apiKey: string,
    model: string,
    jpegBase64: string,
    customHint: string,
  ): Promise<ParsedPackageVisionResult> {
    const userPrompt = customHint.trim()
      ? `Analyze this Ring camera frame for delivered packages. Additional context: ${customHint.trim()}`
      : 'Analyze this Ring camera frame for delivered packages.'

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 320,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${jpegBase64}`,
                  detail: 'low',
                },
              },
            ],
          },
        ],
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI HTTP ${response.status}: ${errText.slice(0, 220)}`)
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = json.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('OpenAI returned an empty vision response')
    }
    return parseVisionResponse(content)
  }

  private async analyzeWithGemini(
    apiKey: string,
    model: string,
    jpegBase64: string,
    customHint: string,
  ): Promise<ParsedPackageVisionResult> {
    const userPrompt = customHint.trim()
      ? `${SYSTEM_PROMPT}\n\nAdditional context: ${customHint.trim()}`
      : SYSTEM_PROMPT

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: userPrompt },
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: jpegBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini HTTP ${response.status}: ${errText.slice(0, 220)}`)
    }

    const json = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> }
      }>
    }
    const content = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (!content) {
      throw new Error('Gemini returned an empty vision response')
    }
    return parseVisionResponse(content)
  }

  private simulateDemoVision(
    cameraId: string,
    cameraName: string,
  ): ParsedPackageVisionResult {
    if (cameraId === 'demo-cam-front' || cameraName.toLowerCase().includes('porch')) {
      return {
        packageDetected: true,
        confidence: 0.96,
        packageCount: 2,
        carrierHint: 'Standard Parcel',
        placement: 'Stacked beside the front door on the HOME welcome mat',
        personPresent: false,
        summary:
          'Two brown cardboard delivery boxes detected resting on the front door welcome mat.',
      }
    }
    return {
      packageDetected: false,
      confidence: 0.94,
      packageCount: 0,
      carrierHint: null,
      placement: null,
      personPresent: false,
      summary: `No packages visible in ${cameraName} frame. Add an OpenAI or Gemini API key in Settings for live cloud vision.`,
    }
  }
}
