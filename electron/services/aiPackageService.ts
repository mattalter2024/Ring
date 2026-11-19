import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  AiProvider,
  PackageDetectionRecord,
  SecurityEvent,
} from '../../shared/types'
import { normalizeGeminiModel, type ConfigStore } from './configStore'
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

const SYSTEM_PROMPT = `You are a precision home-security vision analyzer for wide-angle Ring cameras.
Carefully inspect EVERY ground, porch, step, walkway, driveway, garage apron, yard edge, and patio surface in the image—including shaded areas, corners beside doors/pillars/planters/railings, and distant areas—to determine whether one or more delivered boxes or packages are present.

Count ALL of these as packages:
- Plain brown/kraft cardboard shipping boxes (even with no visible logo or small/angled/partially occluded behind a railing, column, or planter)
- White, black, or branded shipping boxes (Amazon, UPS, FedEx, USPS, DHL, Target, Walmart, Chewy, etc.)
- Padded bubble mailers, Amazon blue-and-white envelopes, and plastic poly mailer bags
- Paper or plastic grocery/food delivery bags left near an entrance
- Stacked or multiple parcels (count each distinct box/parcel)

Do NOT confuse permanent fixtures (welcome mats, potted plants, patio furniture, brick/stone pavers, hoses, trash bins, or siding) with packages. However, if a rectangular cardboard box or delivery parcel is visibly resting on a porch, step, walkway, driveway, or front yard, ALWAYS report "packageDetected": true even if it is plain/unbranded, small, in shadow, or partially obscured.

Respond ONLY with a single valid JSON object matching this exact schema (complete "sceneScan" FIRST before deciding "packageDetected"):
{
  "sceneScan": string, // brief inventory of objects resting on the porch, steps, mat, walkway, driveway, or yard
  "packageDetected": boolean,
  "confidence": number, // 0.0 to 1.0
  "packageCount": integer, // 0 if none, >= 1 if packageDetected is true
  "carrierHint": string | null, // e.g. "Amazon", "UPS", "FedEx", "USPS", "DHL", or null if plain/unclear
  "placement": string | null, // concise location in frame, e.g. "Left of front steps on walkway"
  "personPresent": boolean,
  "summary": string // concise 1-sentence description for a Windows desktop notification
}`

function parseLooseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (lower === 'true' || lower === 'yes' || lower === '1') return true
    if (lower === 'false' || lower === 'no' || lower === '0' || lower === '') return false
  }
  return Boolean(value)
}

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

  const rawCount =
    typeof parsed.packageCount === 'number'
      ? parsed.packageCount
      : Number(parsed.packageCount ?? 0)
  const hasExplicitFlag = parsed.packageDetected !== undefined && parsed.packageDetected !== null
  const packageDetected = hasExplicitFlag
    ? parseLooseBoolean(parsed.packageDetected)
    : Number.isFinite(rawCount) && rawCount >= 1

  const rawConf =
    typeof parsed.confidence === 'number'
      ? parsed.confidence
      : Number(parsed.confidence ?? (packageDetected ? 0.78 : 0.9))
  const confidence = Number.isFinite(rawConf)
    ? Math.max(0, Math.min(1, rawConf > 1 ? rawConf / 100 : rawConf))
    : packageDetected
      ? 0.78
      : 0.9

  const packageCount = packageDetected
    ? Math.max(1, Number.isFinite(rawCount) && rawCount > 0 ? Math.round(rawCount) : 1)
    : 0

  const carrierHint =
    typeof parsed.carrierHint === 'string' && parsed.carrierHint.trim()
      ? parsed.carrierHint.trim()
      : null

  const placement =
    typeof parsed.placement === 'string' && parsed.placement.trim()
      ? parsed.placement.trim()
      : null

  const personPresent = parseLooseBoolean(parsed.personPresent)

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
  private readonly retryDelayMs: number
  private readonly motionFollowUpDelayMs: number
  private history: PackageDetectionRecord[] = []
  private readonly lastNotifiedAtByCamera = new Map<string, number>()
  private readonly inFlightCameras = new Set<string>()
  private readonly followUpTimers = new Map<string, NodeJS.Timeout>()
  private schedulerTimer: NodeJS.Timeout | null = null
  private snapshotSource: SnapshotSource | null = null

  constructor(params: {
    userDataDir: string
    configStore: ConfigStore
    notifications: NotificationService
    onDetection: (record: PackageDetectionRecord) => void
    onSecurityEvent: (event: SecurityEvent) => void
    retryDelayMs?: number
    motionFollowUpDelayMs?: number
  }) {
    this.historyPath = path.join(params.userDataDir, 'package-detections.json')
    this.configStore = params.configStore
    this.notifications = params.notifications
    this.onDetection = params.onDetection
    this.onSecurityEvent = params.onSecurityEvent
    this.retryDelayMs = params.retryDelayMs ?? 800
    this.motionFollowUpDelayMs = params.motionFollowUpDelayMs ?? 12_000
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
    for (const timer of this.followUpTimers.values()) {
      clearTimeout(timer)
    }
    this.followUpTimers.clear()
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

  private scheduleMotionFollowUp(
    cameraId: string,
    trigger: 'motion' | 'doorbell',
  ): void {
    if (this.motionFollowUpDelayMs <= 0) return
    const existing = this.followUpTimers.get(cameraId)
    if (existing) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      this.followUpTimers.delete(cameraId)
      if (!this.snapshotSource || this.inFlightCameras.has(cameraId)) return
      if (!this.shouldTriggerForCamera(cameraId, trigger)) return
      void this.scanCamera(cameraId, trigger)
    }, this.motionFollowUpDelayMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    this.followUpTimers.set(cameraId, timer)
  }

  async handleAutoTrigger(
    cameraId: string,
    trigger: 'motion' | 'doorbell',
  ): Promise<PackageDetectionRecord | null> {
    if (!this.shouldTriggerForCamera(cameraId, trigger)) return null
    if (this.inFlightCameras.has(cameraId)) return null
    const record = await this.scanCamera(cameraId, trigger)
    // Motion often fires while the driver is still walking up with the box.
    // If no package was detected yet, automatically re-check once after the driver leaves.
    if (!record.packageDetected && !record.rawError) {
      this.scheduleMotionFollowUp(cameraId, trigger)
    }
    return record
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
        provider === 'openai'
          ? aiCfg.openaiModel
          : normalizeGeminiModel(aiCfg.geminiModel)

      if (apiKey) {
        if (provider === 'openai') {
          parsed = await this.analyzeWithOpenAI(
            apiKey,
            aiCfg.openaiModel,
            base64,
            aiCfg.customPromptHint,
            meta.name,
          )
        } else {
          const geminiRes = await this.analyzeWithGemini(
            apiKey,
            aiCfg.geminiModel,
            base64,
            aiCfg.customPromptHint,
            meta.name,
          )
          parsed = geminiRes.parsed
          usedModel = geminiRes.modelUsed
        }
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
        const res = await this.invokeGeminiGenerateContent(
          apiKey,
          aiCfg.geminiModel,
          {
            contents: [{ parts: [{ text: 'Reply with OK' }] }],
          },
        )
        return {
          ok: true,
          message:
            res.modelUsed !== aiCfg.geminiModel
              ? `Google Gemini Vision ready (auto-upgraded to ${res.modelUsed})`
              : `Google Gemini Vision ready (${res.modelUsed})`,
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

  private isTransientHttpStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return
    await new Promise((r) => setTimeout(r, ms))
  }

  private async analyzeWithOpenAI(
    apiKey: string,
    model: string,
    jpegBase64: string,
    customHint: string,
    cameraName?: string,
  ): Promise<ParsedPackageVisionResult> {
    const camContext = cameraName ? `Camera: "${cameraName}". ` : ''
    const userPrompt = customHint.trim()
      ? `${camContext}Carefully inspect this full-resolution Ring camera frame for any delivered boxes, cardboard parcels, mailers, or bags on the porch, steps, walkway, driveway, or yard. Additional context: ${customHint.trim()}`
      : `${camContext}Carefully inspect this full-resolution Ring camera frame for any delivered boxes, cardboard parcels, mailers, or bags on the porch, steps, walkway, driveway, or yard.`

    const body = JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 450,
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
                detail: 'high',
              },
            },
          ],
        },
      ],
    })

    let lastError = 'OpenAI API request failed'
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      })

      if (response.ok) {
        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const content = json.choices?.[0]?.message?.content
        if (!content) {
          throw new Error('OpenAI returned an empty vision response')
        }
        return parseVisionResponse(content)
      }

      const errText = await response.text()
      lastError = `OpenAI HTTP ${response.status}: ${errText.slice(0, 220)}`
      if (this.isTransientHttpStatus(response.status) && attempt === 0) {
        await this.sleep(this.retryDelayMs)
        continue
      }
      throw new Error(lastError)
    }

    throw new Error(lastError)
  }

  private extractSuggestedGeminiModel(errText: string, failedModel: string): string | null {
    const matches = errText.matchAll(/models\/([a-z0-9][a-z0-9._-]+)/gi)
    const failedLower = failedModel.toLowerCase()
    for (const match of matches) {
      const candidate = match[1]?.trim().replace(/[.,;:]+$/, '')
      if (candidate && candidate.toLowerCase() !== failedLower) {
        return candidate
      }
    }
    return null
  }

  private extractGeminiText(json: {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; thought?: boolean }>
      }
    }>
  }): string | null {
    const parts = json.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts) || parts.length === 0) return null

    // Gemini 3.x / 4 thinking models may emit thought parts before the JSON answer
    const answerParts = parts
      .filter((p) => !p.thought && typeof p.text === 'string' && p.text.trim())
      .map((p) => p.text!.trim())
    if (answerParts.length > 0) {
      return answerParts.join('\n')
    }

    // Fallback: last text part if all parts lacked a non-thought text block
    for (let i = parts.length - 1; i >= 0; i--) {
      if (typeof parts[i]?.text === 'string' && parts[i].text!.trim()) {
        return parts[i].text!.trim()
      }
    }
    return null
  }

  private async invokeGeminiGenerateContent(
    apiKey: string,
    requestedModel: string,
    payload: Record<string, unknown>,
  ): Promise<{
    json: {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string; thought?: boolean }>
        }
      }>
    }
    modelUsed: string
  }> {
    const normalized = normalizeGeminiModel(requestedModel)
    const fallbackQueue: string[] = [
      normalized,
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview',
      'gemini-3.5-flash-lite',
    ]
    const tried = new Set<string>()
    let lastError = 'Gemini API request failed'
    let requestedModelRetired = normalized !== requestedModel

    while (fallbackQueue.length > 0) {
      const candidateModel = fallbackQueue.shift()!
      if (tried.has(candidateModel.toLowerCase())) continue
      tried.add(candidateModel.toLowerCase())

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent`

      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(payload),
        })

        if (response.ok) {
          const json = (await response.json()) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string; thought?: boolean }>
              }
            }>
          }
          // Persist migrated model only when the requested model was permanently retired (404/deprecated),
          // NOT on a temporary 503 capacity failover
          if (requestedModelRetired && candidateModel !== requestedModel) {
            this.configStore.updateSettings({
              packageAi: { geminiModel: candidateModel },
            })
          }
          return { json, modelUsed: candidateModel }
        }

        const errText = await response.text()
        lastError = `Gemini HTTP ${response.status} (${candidateModel}): ${errText.slice(0, 220)}`

        if (response.status === 404) {
          if (candidateModel.toLowerCase() === normalized.toLowerCase()) {
            requestedModelRetired = true
          }
          const suggested = this.extractSuggestedGeminiModel(errText, candidateModel)
          if (suggested && !tried.has(suggested.toLowerCase())) {
            fallbackQueue.unshift(suggested)
          }
          break
        }

        if (this.isTransientHttpStatus(response.status)) {
          if (attempt === 0) {
            await this.sleep(this.retryDelayMs)
            continue
          }
          // Still overloaded (503/429/5xx) -> temporarily fail over to the next Gemini model
          break
        }

        // Auth/bad-request errors (400/401/403) should fail fast
        throw new Error(lastError)
      }
    }

    throw new Error(lastError)
  }

  private async analyzeWithGemini(
    apiKey: string,
    model: string,
    jpegBase64: string,
    customHint: string,
    cameraName?: string,
  ): Promise<{ parsed: ParsedPackageVisionResult; modelUsed: string }> {
    const camLine = cameraName ? `\nCamera vantage point: "${cameraName}".` : ''
    const hintLine = customHint.trim() ? `\nAdditional context: ${customHint.trim()}` : ''
    const userPrompt = `${SYSTEM_PROMPT}${camLine}${hintLine}`

    const { json, modelUsed } = await this.invokeGeminiGenerateContent(
      apiKey,
      model,
      {
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
          responseMimeType: 'application/json',
        },
      },
    )

    const content = this.extractGeminiText(json)
    if (!content) {
      throw new Error(`Gemini (${modelUsed}) returned an empty vision response`)
    }
    return { parsed: parseVisionResponse(content), modelUsed }
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
