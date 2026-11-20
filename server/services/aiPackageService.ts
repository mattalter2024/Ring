import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  AiProvider,
  AiUsageStats,
  PackageDetectionRecord,
  SecurityEvent,
} from '../../shared/types'
import { normalizeGeminiModel, type ConfigStore } from './configStore'
import { computeLumaSceneChange } from './recordingService'
import type { NotificationService } from './notificationService'

export interface ParsedPackageVisionResult {
  packageDetected: boolean
  confidence: number
  packageCount: number
  carrierHint: string | null
  placement: string | null
  personPresent: boolean
  uncertain?: boolean
  summary: string
}

interface VisionImageBundle {
  currentBase64: string
  baselineBase64?: string | null
  zoomCropBase64?: string | null
  resolution: 'low' | 'high'
}

const COMPACT_TRIAGE_PROMPT = `Home-security delivery detector for a Ring camera frame.
Check ground, porch, steps, mat, walkway, and driveway for ANY delivered cardboard box, shipping parcel, padded/poly mailer, food/grocery delivery bag, or person carrying/dropping a package.
Ignore permanent fixtures (welcome mats, plants, furniture, hoses, bins, parked cars).
Set "uncertain": true ONLY if there is a small, shadowed, or ambiguous new object on the ground that needs a high-resolution zoomed check.
Reply ONLY with valid JSON:
{"packageDetected":boolean,"confidence":0.0-1.0,"packageCount":integer,"carrierHint":string|null,"placement":string|null,"personPresent":boolean,"uncertain":boolean,"summary":"1 concise sentence"}`

const SYSTEM_PROMPT = `High-recall home-security delivery & package vision analyzer for wide-angle Ring cameras.
Inspect EVERY porch, step, mat, walkway, driveway, railing corner, and shaded ground area across ALL provided images.
- If an EARLIER BASELINE (BEFORE) image is provided, compare BEFORE vs AFTER to spot ANY newly appeared box, mailer, or delivery bag while ignoring permanent fixtures already present (mats, plants, furniture, bins, cars).
- If a ZOOMED DELIVERY ZONE image is provided, use its detail for small, flat, angled, or shadowed parcels.
Count as "packageDetected": true: plain/branded cardboard shipping boxes, padded/poly mailers, kraft envelopes, food/grocery delivery bags, or a courier carrying/setting down a parcel.
Reply ONLY with a single valid JSON object:
{"sceneScan":string,"newObjectsFromBaseline":string,"packageDetected":boolean,"confidence":0.0-1.0,"packageCount":integer,"carrierHint":string|null,"placement":string|null,"personPresent":boolean,"summary":"1 concise sentence"}`

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
  const uncertain = parseLooseBoolean(parsed.uncertain)

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
    uncertain,
    summary,
  }
}

export interface SnapshotSource {
  getCameraMeta(cameraId: string): { id: string; name: string } | undefined
  listCameraIds(): string[]
  captureSnapshotBase64(cameraId: string): Promise<{ base64: string; dataUrl: string }>
  cropDeliveryZoneBase64?(jpegBase64: string): Promise<string | null>
  extractLumaGridFromJpegBase64?(jpegBase64: string): Promise<Buffer | null>
}

function getLocalDateKey(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export class AiPackageService {
  private readonly historyPath: string
  private readonly usagePath: string
  private readonly configStore: ConfigStore
  private readonly notifications: NotificationService
  private readonly onDetection: (record: PackageDetectionRecord) => void
  private readonly onSecurityEvent: (event: SecurityEvent) => void
  private readonly onUsageUpdated?: (stats: AiUsageStats) => void
  private readonly retryDelayMs: number
  private readonly motionFollowUpDelaysMs: number[]
  private readonly motionEndDelayMs: number
  private history: PackageDetectionRecord[] = []
  private usage: Omit<AiUsageStats, 'dailyScanLimit'>
  private readonly lastNotifiedAtByCamera = new Map<string, number>()
  private readonly lastNotifiedCountByCamera = new Map<string, number>()
  private readonly lastDetectedAtByCamera = new Map<string, number>()
  private readonly lastDetectedSeqByCamera = new Map<string, number>()
  private readonly lastScanCompletedAtByCamera = new Map<string, number>()
  private readonly lastScanSawPersonByCamera = new Map<string, boolean>()
  private readonly packagePresentByCamera = new Map<string, boolean>()
  private detectionSeq = 0
  private readonly cleanBaselineByCamera = new Map<
    string,
    { base64: string; lumaGrid?: Buffer | null; capturedAtMs: number }
  >()
  private readonly inFlightCameras = new Set<string>()
  private readonly inFlightStartedAtByCamera = new Map<string, number>()
  private readonly pendingAutoTriggerByCamera = new Map<
    string,
    'motion' | 'doorbell'
  >()
  private readonly followUpTimers = new Map<string, Set<NodeJS.Timeout>>()
  private schedulerTimer: NodeJS.Timeout | null = null
  private snapshotSource: SnapshotSource | null = null

  constructor(params: {
    userDataDir: string
    configStore: ConfigStore
    notifications: NotificationService
    onDetection: (record: PackageDetectionRecord) => void
    onSecurityEvent: (event: SecurityEvent) => void
    onUsageUpdated?: (stats: AiUsageStats) => void
    retryDelayMs?: number
    motionFollowUpDelayMs?: number
    motionFollowUpDelaysMs?: number[]
    motionEndDelayMs?: number
  }) {
    this.historyPath = path.join(params.userDataDir, 'package-detections.json')
    this.usagePath = path.join(params.userDataDir, 'ai-usage-stats.json')
    this.configStore = params.configStore
    this.notifications = params.notifications
    this.onDetection = params.onDetection
    this.onSecurityEvent = params.onSecurityEvent
    this.onUsageUpdated = params.onUsageUpdated
    this.retryDelayMs = params.retryDelayMs ?? 800
    if (params.motionFollowUpDelaysMs) {
      this.motionFollowUpDelaysMs = params.motionFollowUpDelaysMs.filter((ms) => ms > 0)
    } else if (params.motionFollowUpDelayMs !== undefined) {
      this.motionFollowUpDelaysMs =
        params.motionFollowUpDelayMs > 0 ? [params.motionFollowUpDelayMs] : []
    } else {
      // Single settled follow-up check (15s) — only scheduled when a person is actively in frame,
      // on a doorbell ring, or after a transient snapshot/API hiccup.
      this.motionFollowUpDelaysMs = [15_000]
    }
    this.motionEndDelayMs = params.motionEndDelayMs ?? 2500
    this.history = this.loadHistory()
    this.usage = this.loadUsage()
  }

  attachSnapshotSource(source: SnapshotSource): void {
    this.snapshotSource = source
    this.syncScheduler()
  }

  private createEmptyUsage(dateKey = getLocalDateKey()): Omit<AiUsageStats, 'dailyScanLimit'> {
    return {
      dateKey,
      scansToday: 0,
      imagesSentToday: 0,
      skippedByLocalGateToday: 0,
      skippedByThrottleToday: 0,
      skippedByAlreadyPresentToday: 0,
      skippedByQuietHoursToday: 0,
      skippedByDailyLimitToday: 0,
    }
  }

  private loadUsage(): Omit<AiUsageStats, 'dailyScanLimit'> {
    const today = getLocalDateKey()
    if (!fs.existsSync(this.usagePath)) return this.createEmptyUsage(today)
    try {
      const parsed = JSON.parse(fs.readFileSync(this.usagePath, 'utf-8')) as Partial<AiUsageStats>
      if (parsed.dateKey !== today) return this.createEmptyUsage(today)
      return {
        dateKey: today,
        scansToday: Number(parsed.scansToday) || 0,
        imagesSentToday: Number(parsed.imagesSentToday) || 0,
        skippedByLocalGateToday: Number(parsed.skippedByLocalGateToday) || 0,
        skippedByThrottleToday: Number(parsed.skippedByThrottleToday) || 0,
        skippedByAlreadyPresentToday: Number(parsed.skippedByAlreadyPresentToday) || 0,
        skippedByQuietHoursToday: Number(parsed.skippedByQuietHoursToday) || 0,
        skippedByDailyLimitToday: Number(parsed.skippedByDailyLimitToday) || 0,
      }
    } catch {
      return this.createEmptyUsage(today)
    }
  }

  private ensureCurrentDayUsage(): void {
    const today = getLocalDateKey()
    if (this.usage.dateKey !== today) {
      this.usage = this.createEmptyUsage(today)
    }
  }

  private saveUsage(): void {
    try {
      fs.writeFileSync(this.usagePath, JSON.stringify(this.usage, null, 2), 'utf-8')
    } catch {
      // Ignore transient disk write failures
    }
    this.onUsageUpdated?.(this.getUsageStats())
  }

  getUsageStats(): AiUsageStats {
    this.ensureCurrentDayUsage()
    const limit = this.configStore.getPublicSettings().packageAi.dailyScanLimit
    return {
      ...this.usage,
      dailyScanLimit: limit,
    }
  }

  recordLocalSkip(
    reason: 'local-gate' | 'throttle' | 'already-present' | 'quiet-hours' | 'daily-limit' = 'local-gate',
  ): void {
    this.ensureCurrentDayUsage()
    if (reason === 'local-gate') this.usage.skippedByLocalGateToday++
    else if (reason === 'throttle') this.usage.skippedByThrottleToday++
    else if (reason === 'already-present') this.usage.skippedByAlreadyPresentToday++
    else if (reason === 'quiet-hours') this.usage.skippedByQuietHoursToday++
    else if (reason === 'daily-limit') this.usage.skippedByDailyLimitToday++
    this.saveUsage()
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
    this.lastScanCompletedAtByCamera.clear()
    this.lastScanSawPersonByCamera.clear()
    this.packagePresentByCamera.clear()
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
        if (this.checkAutoScanGate(camId, 'interval') !== 'ok') continue
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
    this.pendingAutoTriggerByCamera.clear()
    for (const camId of Array.from(this.followUpTimers.keys())) {
      this.cancelFollowUps(camId)
    }
  }

  private isPermanentConfigError(rawError?: string): boolean {
    if (!rawError) return false
    const lower = rawError.toLowerCase()
    return (
      lower.includes('no openai api key') ||
      lower.includes('no gemini api key') ||
      lower.includes('api key not valid') ||
      lower.includes('invalid api key') ||
      lower.includes('http 401') ||
      lower.includes('http 403')
    )
  }

  isWithinActiveHours(now = new Date()): boolean {
    const ai = this.configStore.getPublicSettings().packageAi
    if (!ai.activeHoursEnabled) return true
    const hour = now.getHours()
    const start = ai.activeHoursStart
    const end = ai.activeHoursEnd
    if (start === end) return true
    if (start < end) {
      return hour >= start && hour < end
    }
    // Overnight wrap-around window (e.g. 22 -> 6)
    return hour >= start || hour < end
  }

  private checkAutoScanGate(
    cameraId: string,
    trigger: 'motion' | 'doorbell' | 'interval',
    options?: { isFollowUp?: boolean; now?: Date },
  ): 'ok' | 'quiet-hours' | 'daily-limit' | 'already-present' | 'throttle' {
    const ai = this.configStore.getPublicSettings().packageAi
    const now = options?.now ?? new Date()
    const nowMs = now.getTime()
    this.ensureCurrentDayUsage()

    // 1. Active delivery hours (doorbell presses always bypass quiet hours)
    if ((trigger === 'motion' || trigger === 'interval') && !this.isWithinActiveHours(now)) {
      this.recordLocalSkip('quiet-hours')
      return 'quiet-hours'
    }

    // 2. Daily auto-scan safety cap (manual scans never hit this gate)
    if (ai.dailyScanLimit > 0 && this.usage.scansToday >= ai.dailyScanLimit) {
      this.recordLocalSkip('daily-limit')
      return 'daily-limit'
    }

    // 3. Pause repeated motion scans while a package is already confirmed sitting on this camera
    if (
      ai.pauseWhilePackagePresent &&
      trigger === 'motion' &&
      this.packagePresentByCamera.get(cameraId)
    ) {
      const lastDetectedAt = this.lastDetectedAtByCamera.get(cameraId) ?? 0
      const pauseWindowMs = Math.max(
        ai.cooldownMinutes * 60_000,
        ai.minScanIntervalSeconds * 1000,
      )
      if (pauseWindowMs > 0 && nowMs - lastDetectedAt < pauseWindowMs) {
        this.recordLocalSkip('already-present')
        return 'already-present'
      }
    }

    // 4. Per-camera minimum scan interval throttle (bypassed by doorbell and active follow-ups)
    if (!options?.isFollowUp && trigger === 'motion' && ai.minScanIntervalSeconds > 0) {
      const lastScanAt = this.lastScanCompletedAtByCamera.get(cameraId) ?? 0
      if (lastScanAt > 0 && nowMs - lastScanAt < ai.minScanIntervalSeconds * 1000) {
        this.recordLocalSkip('throttle')
        return 'throttle'
      }
    }

    return 'ok'
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
        if (this.checkAutoScanGate(cameraId, trigger, { isFollowUp: true }) !== 'ok') return
        if (this.inFlightCameras.has(cameraId)) {
          this.pendingAutoTriggerByCamera.set(cameraId, trigger)
          return
        }

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
              if (this.checkAutoScanGate(cameraId, trigger, { isFollowUp: true }) !== 'ok') return
              void this.scanCamera(cameraId, trigger)
            })
          }
        })
      })
    })
  }

  /**
   * Called when Ring reports that a camera's motion period has ended (driver left the porch).
   * Schedules an unobstructed verification scan only when a courier was seen during the motion
   * burst or when the scan interval throttle has elapsed, avoiding redundant API calls on empty motion.
   */
  handleMotionEnded(cameraId: string): void {
    if (!this.snapshotSource) return
    if (!this.shouldTriggerForCamera(cameraId, 'motion')) return
    const lastHit = this.lastDetectedAtByCamera.get(cameraId) ?? 0
    if (Date.now() - lastHit < 90_000) return

    const ai = this.configStore.getPublicSettings().packageAi
    const sawPerson = this.lastScanSawPersonByCamera.get(cameraId) === true
    const lastScanAt = this.lastScanCompletedAtByCamera.get(cameraId) ?? 0
    const throttleMs = ai.minScanIntervalSeconds * 1000
    if (!sawPerson && throttleMs > 0 && lastScanAt > 0 && Date.now() - lastScanAt < throttleMs) {
      this.recordLocalSkip('throttle')
      return
    }

    const scheduledSeq = this.detectionSeq
    this.scheduleTimer(cameraId, this.motionEndDelayMs, () => {
      if (!this.snapshotSource) return
      if (!this.shouldTriggerForCamera(cameraId, 'motion')) return
      const hitSeq = this.lastDetectedSeqByCamera.get(cameraId) ?? 0
      if (hitSeq > scheduledSeq) return
      if (
        this.checkAutoScanGate(cameraId, 'motion', { isFollowUp: sawPerson }) !== 'ok'
      ) {
        return
      }
      if (this.inFlightCameras.has(cameraId)) {
        this.pendingAutoTriggerByCamera.set(cameraId, 'motion')
        return
      }
      void this.scanCamera(cameraId, 'motion')
    })
  }

  async handleAutoTrigger(
    cameraId: string,
    trigger: 'motion' | 'doorbell',
  ): Promise<PackageDetectionRecord | null> {
    if (!this.shouldTriggerForCamera(cameraId, trigger)) return null
    if (this.inFlightCameras.has(cameraId)) {
      // Ignore duplicate synchronous callback fire from onMotionDetected + onNewNotification
      // for the exact same Ring event, but queue genuine follow-up/overlapping triggers.
      const startedAt = this.inFlightStartedAtByCamera.get(cameraId) ?? 0
      if (trigger === 'doorbell' || Date.now() - startedAt >= 1000) {
        const existing = this.pendingAutoTriggerByCamera.get(cameraId)
        if (existing !== 'doorbell') {
          this.pendingAutoTriggerByCamera.set(cameraId, trigger)
        }
      }
      return null
    }

    if (this.checkAutoScanGate(cameraId, trigger) !== 'ok') {
      return null
    }

    const burstStartSeq = this.detectionSeq
    const record = await this.scanCamera(cameraId, trigger)
    // Cost-saver #2: Only schedule a follow-up check if a courier/person was actually in frame,
    // someone rang the doorbell, or a transient API/snapshot error occurred. Empty motion
    // (passing cars, trees, shadows) completes in 1 single scan instead of 3-5 scans.
    const locallySkipped = record.imagesSubmitted === 0 && !record.rawError
    const needsFollowUp =
      !locallySkipped &&
      !record.packageDetected &&
      !this.isPermanentConfigError(record.rawError) &&
      (record.personPresent || Boolean(record.rawError) || trigger === 'doorbell')
    if (needsFollowUp) {
      this.scheduleMotionFollowUps(cameraId, trigger, burstStartSeq)
    }
    return record
  }

  private async runVisionProviderCall(
    provider: AiProvider,
    apiKey: string,
    aiCfg: { openaiModel: string; geminiModel: string; customPromptHint: string },
    bundle: VisionImageBundle,
    cameraName: string,
  ): Promise<{ parsed: ParsedPackageVisionResult; modelUsed: string; imagesSent: number }> {
    const imagesSent =
      1 + (bundle.baselineBase64 ? 1 : 0) + (bundle.zoomCropBase64 ? 1 : 0)
    if (provider === 'openai') {
      const parsed = await this.analyzeWithOpenAI(
        apiKey,
        aiCfg.openaiModel,
        bundle,
        aiCfg.customPromptHint,
        cameraName,
      )
      return { parsed, modelUsed: aiCfg.openaiModel, imagesSent }
    }
    const geminiRes = await this.analyzeWithGemini(
      apiKey,
      aiCfg.geminiModel,
      bundle,
      aiCfg.customPromptHint,
      cameraName,
    )
    return { parsed: geminiRes.parsed, modelUsed: geminiRes.modelUsed, imagesSent }
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

    const started = Date.now()
    this.inFlightCameras.add(cameraId)
    this.inFlightStartedAtByCamera.set(cameraId, started)
    let detectedInThisScan = false
    const settings = this.configStore.getPublicSettings()
    const aiCfg = settings.packageAi

    try {
      const { base64, dataUrl } =
        await this.snapshotSource.captureSnapshotBase64(cameraId)

      const cachedBaseline = this.cleanBaselineByCamera.get(cameraId)
      const baselineFresh = Boolean(
        cachedBaseline && Date.now() - cachedBaseline.capturedAtMs < 24 * 60 * 60 * 1000,
      )

      // Extract tiny 64x36 grayscale grid ($0 local CPU) for persistent-change gating
      let currLumaGrid: Buffer | null = null
      if (typeof this.snapshotSource.extractLumaGridFromJpegBase64 === 'function') {
        try {
          currLumaGrid = await this.snapshotSource.extractLumaGridFromJpegBase64(base64)
        } catch {
          currLumaGrid = null
        }
      }

      // Cost-saver #1: Local Persistent-Baseline Gate ($0)
      // On motion triggers, if we have a confirmed clean empty-porch baseline and the current
      // frame still matches it (car drove by, shadow flickered, person walked past leaving nothing),
      // skip Cloud Vision completely and save 100% of API spend for this event.
      if (
        trigger === 'motion' &&
        aiCfg.requirePersistentChange &&
        baselineFresh &&
        cachedBaseline?.lumaGrid &&
        currLumaGrid
      ) {
        const diff = computeLumaSceneChange(cachedBaseline.lumaGrid, currLumaGrid)
        if (!diff.significant) {
          this.recordLocalSkip('local-gate')
          this.lastScanSawPersonByCamera.set(cameraId, false)
          this.cancelFollowUps(cameraId)
          return {
            id: crypto.randomUUID(),
            cameraId,
            cameraName: meta.name,
            timestamp: new Date().toISOString(),
            provider: aiCfg.provider,
            model:
              aiCfg.provider === 'openai'
                ? aiCfg.openaiModel
                : normalizeGeminiModel(aiCfg.geminiModel),
            trigger,
            packageDetected: false,
            confidence: 0.99,
            packageCount: 0,
            carrierHint: null,
            placement: null,
            personPresent: false,
            summary: 'Skipped cloud AI ($0 local baseline match — scene unchanged).',
            snapshotDataUrl: dataUrl,
            notified: false,
            latencyMs: Date.now() - started,
            imagesSubmitted: 0,
          }
        }
      }

      const baselineBase64 =
        baselineFresh && cachedBaseline && cachedBaseline.base64 !== base64
          ? cachedBaseline.base64
          : null

      const getZoomCrop = async (): Promise<string | null> => {
        if (typeof this.snapshotSource?.cropDeliveryZoneBase64 !== 'function') return null
        try {
          return await this.snapshotSource.cropDeliveryZoneBase64(base64)
        } catch {
          return null
        }
      }

      const provider = aiCfg.provider
      const apiKey =
        provider === 'openai'
          ? this.configStore.getOpenaiApiKey()
          : this.configStore.getGeminiApiKey()

      const qualityMode = aiCfg.scanQualityMode ?? 'balanced'
      let parsed: ParsedPackageVisionResult
      let usedProvider: AiProvider | 'demo-vision' = provider
      let usedModel =
        provider === 'openai'
          ? aiCfg.openaiModel
          : normalizeGeminiModel(aiCfg.geminiModel)
      let imagesSubmitted = 0

      if (apiKey) {
        if (qualityMode === 'economy') {
          // Cost-saver #3 (Economy): Always 1 low-res frame, zero escalations
          const res = await this.runVisionProviderCall(
            provider,
            apiKey,
            aiCfg,
            { currentBase64: base64, resolution: 'low' },
            meta.name,
          )
          parsed = res.parsed
          usedModel = res.modelUsed
          imagesSubmitted = res.imagesSent
        } else if (qualityMode === 'balanced') {
          // Cost-saver #3 (Balanced — Recommended):
          // Stage 1: Cheap single low-res triage frame (~85 tokens on OpenAI / low-res on Gemini).
          // Stage 2: Escalate to high-res + zoomed delivery crop ONLY if Stage 1 is uncertain
          // or reports a borderline package (< 0.85 confidence).
          const stage1 = await this.runVisionProviderCall(
            provider,
            apiKey,
            aiCfg,
            { currentBase64: base64, resolution: 'low' },
            meta.name,
          )
          parsed = stage1.parsed
          usedModel = stage1.modelUsed
          imagesSubmitted = stage1.imagesSent

          const needsHighResVerify =
            Boolean(stage1.parsed.uncertain) ||
            (stage1.parsed.packageDetected && stage1.parsed.confidence < 0.85)
          if (needsHighResVerify) {
            const zoomCropBase64 = await getZoomCrop()
            const stage2 = await this.runVisionProviderCall(
              provider,
              apiKey,
              aiCfg,
              {
                currentBase64: base64,
                baselineBase64,
                zoomCropBase64,
                resolution: 'high',
              },
              meta.name,
            )
            parsed = stage2.parsed
            usedModel = stage2.modelUsed
            imagesSubmitted += stage2.imagesSent
          }
        } else {
          // High Accuracy mode: full BEFORE baseline + AFTER current + zoomed delivery crop at high res
          const zoomCropBase64 = await getZoomCrop()
          const res = await this.runVisionProviderCall(
            provider,
            apiKey,
            aiCfg,
            {
              currentBase64: base64,
              baselineBase64,
              zoomCropBase64,
              resolution: 'high',
            },
            meta.name,
          )
          parsed = res.parsed
          usedModel = res.modelUsed
          imagesSubmitted = res.imagesSent
        }

        this.ensureCurrentDayUsage()
        this.usage.scansToday += 1
        this.usage.imagesSentToday += imagesSubmitted
        this.saveUsage()
      } else if (settings.mode === 'demo') {
        usedProvider = 'demo-vision'
        usedModel = 'demo-simulator'
        parsed = this.simulateDemoVision(cameraId, meta.name)
        imagesSubmitted = 0
      } else {
        throw new Error(
          `No ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API key configured. Add your API key in Settings -> Cloud Vision AI.`,
        )
      }

      const completedAt = Date.now()
      this.lastScanCompletedAtByCamera.set(cameraId, completedAt)
      this.lastScanSawPersonByCamera.set(cameraId, parsed.personPresent)
      this.packagePresentByCamera.set(cameraId, parsed.packageDetected)

      // Update clean empty-porch baseline (including 64x36 luma grid) whenever scene is confirmed clear
      if (!parsed.packageDetected) {
        this.lastNotifiedCountByCamera.set(cameraId, 0)
        if (!parsed.personPresent) {
          this.cleanBaselineByCamera.set(cameraId, {
            base64,
            lumaGrid: currLumaGrid,
            capturedAtMs: completedAt,
          })
        }
      } else {
        detectedInThisScan = true
        this.lastDetectedAtByCamera.set(cameraId, completedAt)
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
        imagesSubmitted,
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
      this.inFlightStartedAtByCamera.delete(cameraId)
      const pendingTrigger = this.pendingAutoTriggerByCamera.get(cameraId)
      if (pendingTrigger) {
        this.pendingAutoTriggerByCamera.delete(cameraId)
        if (
          (!detectedInThisScan || pendingTrigger === 'doorbell') &&
          this.snapshotSource &&
          this.shouldTriggerForCamera(cameraId, pendingTrigger)
        ) {
          const delayMs = Math.min(Math.max(this.motionEndDelayMs, 50), 1000)
          this.scheduleTimer(cameraId, delayMs, () => {
            if (!this.snapshotSource || this.inFlightCameras.has(cameraId)) return
            void this.handleAutoTrigger(cameraId, pendingTrigger)
          })
        }
      }
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
    const isLowRes = images.resolution === 'low'
    const detailLevel: 'low' | 'high' = isLowRes ? 'low' : 'high'
    const camContext = cameraName ? `Camera: "${cameraName}". ` : ''
    const hintContext = customHint.trim() ? ` Context: ${customHint.trim()}` : ''

    const userContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail: 'low' | 'high' } }
    > = []

    if (isLowRes) {
      userContent.push({
        type: 'text',
        text: `${camContext}Inspect for delivered boxes/parcels/bags or an active courier.${hintContext}`,
      })
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${images.currentBase64}`,
          detail: 'low',
        },
      })
    } else {
      if (images.baselineBase64) {
        userContent.push({
          type: 'text',
          text: `${camContext}Compare BEFORE baseline vs AFTER current${images.zoomCropBase64 ? ' + ZOOMED DELIVERY ZONE' : ''} for newly delivered packages.${hintContext}\n\nImage 1 — BEFORE:`,
        })
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${images.baselineBase64}`,
            detail: detailLevel,
          },
        })
        userContent.push({
          type: 'text',
          text: 'Image 2 — AFTER:',
        })
      } else {
        userContent.push({
          type: 'text',
          text: `${camContext}Inspect this Ring frame${images.zoomCropBase64 ? ' + ZOOMED DELIVERY ZONE' : ''} for delivered boxes, mailers, bags, or a courier.${hintContext}`,
        })
      }

      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${images.currentBase64}`,
          detail: detailLevel,
        },
      })

      if (images.zoomCropBase64) {
        userContent.push({
          type: 'text',
          text: 'ZOOMED DELIVERY ZONE:',
        })
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${images.zoomCropBase64}`,
            detail: detailLevel,
          },
        })
      }
    }

    const body = JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 220,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: isLowRes ? COMPACT_TRIAGE_PROMPT : SYSTEM_PROMPT },
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
      let strippedThinkingConfig = false

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

        // Gracefully strip optional generationConfig fields (thinkingConfig / mediaResolution)
        // if a specific Gemini model rejects them with HTTP 400.
        if (
          response.status === 400 &&
          typeof currentPayload.generationConfig === 'object' &&
          currentPayload.generationConfig !== null
        ) {
          const genCfg = currentPayload.generationConfig as Record<string, unknown>
          const errLower = errText.toLowerCase()
          const hasThinking = !strippedThinkingConfig && 'thinkingConfig' in genCfg
          const hasMediaRes = !strippedMediaResolution && 'mediaResolution' in genCfg

          if (hasThinking && (errLower.includes('thinking') || !hasMediaRes)) {
            const { thinkingConfig: _drop, ...restGen } = genCfg
            currentPayload = { ...currentPayload, generationConfig: restGen }
            strippedThinkingConfig = true
            attempt = -1
            continue
          }
          if (hasMediaRes && (errLower.includes('mediaresolution') || errLower.includes('media_resolution') || !hasThinking)) {
            const { mediaResolution: _drop, ...restGen } = genCfg
            currentPayload = { ...currentPayload, generationConfig: restGen }
            strippedMediaResolution = true
            attempt = -1
            continue
          }
          if (hasThinking) {
            const { thinkingConfig: _drop, ...restGen } = genCfg
            currentPayload = { ...currentPayload, generationConfig: restGen }
            strippedThinkingConfig = true
            attempt = -1
            continue
          }
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
    const isLowRes = images.resolution === 'low'
    const camLine = cameraName ? `\nCamera: "${cameraName}".` : ''
    const hintLine = customHint.trim() ? `\nContext: ${customHint.trim()}` : ''
    const userPrompt = `${isLowRes ? COMPACT_TRIAGE_PROMPT : SYSTEM_PROMPT}${camLine}${hintLine}`

    const parts: Array<
      | { text: string }
      | { inline_data: { mime_type: string; data: string } }
    > = [{ text: userPrompt }]

    if (!isLowRes && images.baselineBase64) {
      parts.push({ text: 'Image 1 — BEFORE:' })
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: images.baselineBase64,
        },
      })
      parts.push({ text: 'Image 2 — AFTER:' })
    } else if (!isLowRes) {
      parts.push({ text: 'CURRENT FRAME:' })
    }

    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: images.currentBase64,
      },
    })

    if (!isLowRes && images.zoomCropBase64) {
      parts.push({ text: 'ZOOMED DELIVERY ZONE:' })
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
          maxOutputTokens: 220,
          mediaResolution: isLowRes ? 'MEDIA_RESOLUTION_LOW' : 'MEDIA_RESOLUTION_HIGH',
          thinkingConfig: { thinkingBudget: 0 },
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
