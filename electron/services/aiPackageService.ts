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

interface VisionImageBundle {
  currentBase64: string
  baselineBase64?: string | null
  zoomCropBase64?: string | null
}

const SYSTEM_PROMPT = `You are a high-recall home-security delivery & package vision analyzer for wide-angle Ring cameras.
Your #1 job is to NEVER miss a real delivery while ignoring permanent fixtures.

Carefully inspect EVERY ground, porch, step, welcome mat, walkway, driveway, garage apron, yard edge, railing corner, bench, and planter area across ALL provided images (including shaded areas, bright glare, corners, and distant ground).

When an EARLIER BASELINE ("BEFORE") image is provided alongside the CURRENT ("AFTER") image:
- FIRST compare BEFORE vs AFTER to spot ANY newly appeared object resting on the ground, porch, steps, mat, walkway, or driveway, or anyone delivering an item.
- A newly appeared cardboard box, white/poly mailer, padded envelope, or delivery bag that was NOT in the baseline is almost certainly a delivery—report "packageDetected": true!

When a ZOOMED DELIVERY ZONE image is provided:
- Use its extra pixel detail to spot small, flat, angled, or shadowed boxes, envelopes, and bags that look tiny in the wide-angle frame.

Count ALL of these as "packageDetected": true:
- Plain brown/kraft cardboard shipping boxes of ANY size (even unbranded, small, angled, shadowed, or partially behind a railing/pillar/planter)
- Branded or white/colored shipping boxes (Amazon, UPS, FedEx, USPS, DHL, Target, Walmart, Chewy, etc.)
- Padded bubble mailers, Amazon blue-and-white envelopes, kraft envelopes, and plastic poly mailer bags lying flat or propped up
- Paper or plastic grocery/food/retail delivery bags (DoorDash, Uber Eats, Instacart, Grubhub, etc.) left near an entrance
- Large/oversized boxes, stacked parcels, or multiple boxes (count each distinct item)
- ACTIVE DELIVERIES IN PROGRESS: a courier/delivery driver or person carrying, holding, or setting down a shipping box, mailer, or delivery bag

Do NOT count permanent fixtures already present in the baseline (welcome mats, potted plants, patio furniture, bricks/pavers, hoses, trash bins, siding, parked cars).

Respond ONLY with a single valid JSON object matching this exact schema (complete "sceneScan" and "newObjectsFromBaseline" FIRST before deciding "packageDetected"):
{
  "sceneScan": string, // brief inventory of objects on the porch, steps, mat, walkway, driveway, or yard
  "newObjectsFromBaseline": string, // what NEW objects or people appeared compared to baseline, or "No baseline provided"
  "packageDetected": boolean,
  "confidence": number, // 0.0 to 1.0
  "packageCount": integer, // 0 if none, >= 1 if packageDetected is true
  "carrierHint": string | null, // e.g. "Amazon", "UPS", "FedEx", "USPS", "DHL", "Food/Grocery", or null if plain/unclear
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
  cropDeliveryZoneBase64?(jpegBase64: string): Promise<string | null>
}

export class AiPackageService {
  private readonly historyPath: string
  private readonly configStore: ConfigStore
  private readonly notifications: NotificationService
  private readonly onDetection: (record: PackageDetectionRecord) => void
  private readonly onSecurityEvent: (event: SecurityEvent) => void
  private readonly retryDelayMs: number
  private readonly motionFollowUpDelaysMs: number[]
  private readonly motionEndDelayMs: number
  private history: PackageDetectionRecord[] = []
  private readonly lastNotifiedAtByCamera = new Map<string, number>()
  private readonly lastNotifiedCountByCamera = new Map<string, number>()
  private readonly lastDetectedAtByCamera = new Map<string, number>()
  private readonly lastDetectedSeqByCamera = new Map<string, number>()
  private detectionSeq = 0
  private readonly cleanBaselineByCamera = new Map<
    string,
    { base64: string; capturedAtMs: number }
  >()
  private readonly inFlightCameras = new Set<string>()
  private readonly followUpTimers = new Map<string, Set<NodeJS.Timeout>>()
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
    motionFollowUpDelaysMs?: number[]
    motionEndDelayMs?: number
  }) {
    this.historyPath = path.join(params.userDataDir, 'package-detections.json')
    this.configStore = params.configStore
    this.notifications = params.notifications
    this.onDetection = params.onDetection
    this.onSecurityEvent = params.onSecurityEvent
    this.retryDelayMs = params.retryDelayMs ?? 800
    if (params.motionFollowUpDelaysMs) {
      this.motionFollowUpDelaysMs = params.motionFollowUpDelaysMs.filter((ms) => ms > 0)
    } else if (params.motionFollowUpDelayMs !== undefined) {
      this.motionFollowUpDelaysMs =
        params.motionFollowUpDelayMs > 0
          ? [params.motionFollowUpDelayMs, params.motionFollowUpDelayMs * 2]
          : []
    } else {
      // Multi-stage verification: mid-delivery (12s) + post-drop departure (28s)
      this.motionFollowUpDelaysMs = [12_000, 28_000]
    }
    this.motionEndDelayMs = params.motionEndDelayMs ?? 2500
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
    this.lastNotifiedCountByCamera.clear()
    this.lastDetectedAtByCamera.clear()
    this.lastDetectedSeqByCamera.clear()
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

  private cancelFollowUps(cameraId: string): void {
    const timers = this.followUpTimers.get(cameraId)
    if (!timers) return
    for (const timer of timers) {
      clearTimeout(timer)
    }
    this.followUpTimers.delete(cameraId)
  }

  stop(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer)
      this.schedulerTimer = null
    }
    for (const camId of Array.from(this.followUpTimers.keys())) {
      this.cancelFollowUps(camId)
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

  private scheduleTimer(cameraId: string, delayMs: number, fn: () => void): void {
    if (delayMs <= 0) return
    let set = this.followUpTimers.get(cameraId)
    if (!set) {
      set = new Set()
      this.followUpTimers.set(cameraId, set)
    }
    const timer = setTimeout(() => {
      set?.delete(timer)
      if (set && set.size === 0) {
        this.followUpTimers.delete(cameraId)
      }
      fn()
    }, delayMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    set.add(timer)
  }

  private scheduleMotionFollowUps(
    cameraId: string,
    trigger: 'motion' | 'doorbell',
    burstStartSeq: number,
  ): void {
    if (this.motionFollowUpDelaysMs.length === 0) return
    this.cancelFollowUps(cameraId)

    this.motionFollowUpDelaysMs.forEach((delayMs, idx) => {
      const isFinalStep = idx === this.motionFollowUpDelaysMs.length - 1
      this.scheduleTimer(cameraId, delayMs, () => {
        if (!this.snapshotSource) return
        if (!this.shouldTriggerForCamera(cameraId, trigger)) return
        const lastHitSeq = this.lastDetectedSeqByCamera.get(cameraId) ?? 0
        if (lastHitSeq > burstStartSeq) return
        if (this.inFlightCameras.has(cameraId)) return

        void this.scanCamera(cameraId, trigger).then((rec) => {
          // If a person/courier is still in frame at the final follow-up without a dropped box yet,
          // schedule one extra post-departure check once they step away.
          if (
            isFinalStep &&
            rec.personPresent &&
            !rec.packageDetected &&
            !rec.rawError
          ) {
            const extraDelay = Math.max(delayMs, 15_000)
            this.scheduleTimer(cameraId, extraDelay, () => {
              if (!this.snapshotSource || this.inFlightCameras.has(cameraId)) return
              if (!this.shouldTriggerForCamera(cameraId, trigger)) return
              const hitSeq = this.lastDetectedSeqByCamera.get(cameraId) ?? 0
              if (hitSeq > burstStartSeq) return
              void this.scanCamera(cameraId, trigger)
            })
          }
        })
      })
    })
  }

  /**
   * Called when Ring reports that a camera's motion period has ended (driver left the porch).
   * Schedules a single unobstructed verification scan if no package was spotted during the burst.
   */
  handleMotionEnded(cameraId: string): void {
    if (!this.snapshotSource) return
    if (!this.shouldTriggerForCamera(cameraId, 'motion')) return
    const lastHit = this.lastDetectedAtByCamera.get(cameraId) ?? 0
    if (Date.now() - lastHit < 90_000) return

    const scheduledSeq = this.detectionSeq
    this.scheduleTimer(cameraId, this.motionEndDelayMs, () => {
      if (!this.snapshotSource || this.inFlightCameras.has(cameraId)) return
      if (!this.shouldTriggerForCamera(cameraId, 'motion')) return
      const hitSeq = this.lastDetectedSeqByCamera.get(cameraId) ?? 0
      if (hitSeq > scheduledSeq) return
      void this.scanCamera(cameraId, 'motion')
    })
  }

  async handleAutoTrigger(
    cameraId: string,
    trigger: 'motion' | 'doorbell',
  ): Promise<PackageDetectionRecord | null> {
    if (!this.shouldTriggerForCamera(cameraId, trigger)) return null
    if (this.inFlightCameras.has(cameraId)) return null
    const burstStartSeq = this.detectionSeq
    const record = await this.scanCamera(cameraId, trigger)
    // Motion often fires while the delivery driver is still approaching the porch.
    // If no package was detected yet, schedule multi-stage follow-up verification scans.
    if (!record.packageDetected && !record.rawError) {
      this.scheduleMotionFollowUps(cameraId, trigger, burstStartSeq)
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

      // Prepare multi-image context: previous clean empty-porch baseline + zoomed ground delivery crop
      const cachedBaseline = this.cleanBaselineByCamera.get(cameraId)
      const baselineBase64 =
        cachedBaseline &&
        cachedBaseline.base64 !== base64 &&
        Date.now() - cachedBaseline.capturedAtMs < 24 * 60 * 60 * 1000
          ? cachedBaseline.base64
          : null

      let zoomCropBase64: string | null = null
      if (typeof this.snapshotSource.cropDeliveryZoneBase64 === 'function') {
        try {
          zoomCropBase64 = await this.snapshotSource.cropDeliveryZoneBase64(base64)
        } catch {
          zoomCropBase64 = null
        }
      }

      const imageBundle: VisionImageBundle = {
        currentBase64: base64,
        baselineBase64,
        zoomCropBase64,
      }

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
            imageBundle,
            aiCfg.customPromptHint,
            meta.name,
          )
        } else {
          const geminiRes = await this.analyzeWithGemini(
            apiKey,
            aiCfg.geminiModel,
            imageBundle,
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

      // Update clean empty-porch baseline whenever the scene is confirmed clear
      if (!parsed.packageDetected) {
        this.lastNotifiedCountByCamera.set(cameraId, 0)
        if (!parsed.personPresent) {
          this.cleanBaselineByCamera.set(cameraId, {
            base64,
            capturedAtMs: Date.now(),
          })
        }
      } else {
        this.lastDetectedAtByCamera.set(cameraId, Date.now())
        this.lastDetectedSeqByCamera.set(cameraId, ++this.detectionSeq)
        this.cancelFollowUps(cameraId)
      }

      const latencyMs = Date.now() - started
      const meetsConfidence =
        parsed.packageDetected && parsed.confidence >= aiCfg.minConfidence
      const cooldownMs = aiCfg.cooldownMinutes * 60 * 1000
      const lastNotified = this.lastNotifiedAtByCamera.get(cameraId) ?? 0
      const prevNotifiedCount = this.lastNotifiedCountByCamera.get(cameraId) ?? 0
      const additionalPackagesArrived =
        parsed.packageDetected && parsed.packageCount > prevNotifiedCount
      const cooldownPassed =
        trigger === 'manual' ||
        additionalPackagesArrived ||
        Date.now() - lastNotified >= cooldownMs

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
        this.lastNotifiedCountByCamera.set(cameraId, parsed.packageCount)
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
    images: VisionImageBundle,
    customHint: string,
    cameraName?: string,
  ): Promise<ParsedPackageVisionResult> {
    const camContext = cameraName ? `Camera: "${cameraName}". ` : ''
    const hintContext = customHint.trim()
      ? ` Additional context: ${customHint.trim()}`
      : ''

    const userContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail: 'high' } }
    > = []

    if (images.baselineBase64) {
      userContent.push({
        type: 'text',
        text: `${camContext}Compare the EARLIER BASELINE (empty scene) image against the CURRENT frame${images.zoomCropBase64 ? ' and the ZOOMED DELIVERY ZONE crop' : ''} to detect any newly delivered boxes, parcels, mailers, delivery bags, or an active delivery in progress.${hintContext}\n\nImage 1 — EARLIER BASELINE (BEFORE):`,
      })
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${images.baselineBase64}`,
          detail: 'high',
        },
      })
      userContent.push({
        type: 'text',
        text: 'Image 2 — CURRENT FULL FRAME (AFTER):',
      })
    } else {
      userContent.push({
        type: 'text',
        text: `${camContext}Carefully inspect this full-resolution Ring camera frame${images.zoomCropBase64 ? ' and its ZOOMED DELIVERY ZONE crop' : ''} for any delivered boxes, cardboard parcels, mailers, delivery bags, or an active delivery in progress.${hintContext}\n\nCURRENT FULL FRAME:`,
      })
    }

    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${images.currentBase64}`,
        detail: 'high',
      },
    })

    if (images.zoomCropBase64) {
      userContent.push({
        type: 'text',
        text: 'ZOOMED DELIVERY ZONE (lower porch, steps, doormat, walkway, driveway):',
      })
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${images.zoomCropBase64}`,
          detail: 'high',
        },
      })
    }

    const body = JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
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
      let currentPayload: Record<string, unknown> = payload
      let strippedMediaResolution = false

      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(currentPayload),
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

        // If a specific Gemini model rejects mediaResolution in generationConfig (HTTP 400),
        // strip mediaResolution and immediately retry on the same model.
        if (
          response.status === 400 &&
          !strippedMediaResolution &&
          typeof currentPayload.generationConfig === 'object' &&
          currentPayload.generationConfig !== null &&
          'mediaResolution' in (currentPayload.generationConfig as Record<string, unknown>)
        ) {
          const { mediaResolution: _drop, ...restGen } = currentPayload.generationConfig as Record<
            string,
            unknown
          >
          currentPayload = { ...currentPayload, generationConfig: restGen }
          strippedMediaResolution = true
          attempt = -1
          continue
        }

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
    images: VisionImageBundle,
    customHint: string,
    cameraName?: string,
  ): Promise<{ parsed: ParsedPackageVisionResult; modelUsed: string }> {
    const camLine = cameraName ? `\nCamera vantage point: "${cameraName}".` : ''
    const hintLine = customHint.trim() ? `\nAdditional context: ${customHint.trim()}` : ''
    const userPrompt = `${SYSTEM_PROMPT}${camLine}${hintLine}`

    const parts: Array<
      | { text: string }
      | { inline_data: { mime_type: string; data: string } }
    > = [{ text: userPrompt }]

    if (images.baselineBase64) {
      parts.push({ text: 'Image 1 — EARLIER CLEAN BASELINE (BEFORE):' })
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: images.baselineBase64,
        },
      })
      parts.push({ text: 'Image 2 — CURRENT FULL FRAME (AFTER):' })
    } else {
      parts.push({ text: 'CURRENT FULL FRAME:' })
    }

    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: images.currentBase64,
      },
    })

    if (images.zoomCropBase64) {
      parts.push({
        text: 'ZOOMED DELIVERY ZONE (lower porch, steps, doormat, walkway, driveway):',
      })
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: images.zoomCropBase64,
        },
      })
    }

    const { json, modelUsed } = await this.invokeGeminiGenerateContent(
      apiKey,
      model,
      {
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          mediaResolution: 'MEDIA_RESOLUTION_HIGH',
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
