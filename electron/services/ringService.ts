import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { Subscription } from 'rxjs'
import type {
  AlarmMode,
  AppMode,
  AppSettings,
  CloudRecordingItem,
  ConnectionStatus,
  DiskHealthStatus,
  LiveStreamSession,
  LocalRecordingItem,
  NvrCameraStatus,
  NvrStatus,
  RingAuthStepResult,
  RingCameraInfo,
  RingLocationInfo,
  RingSensorInfo,
  SecurityEvent,
  SensorCategory,
} from '../../shared/types'
import type { ConfigStore } from './configStore'
import type { StreamService, StreamableRingCamera } from './streamService'
import type { RecordingService, RecordableRingCamera } from './recordingService'
import type { AiPackageService, SnapshotSource } from './aiPackageService'
import type { NotificationService } from './notificationService'

type RingClientApiModule = typeof import('ring-client-api')
type RingRestClientModule = typeof import('ring-client-api/rest-client')
type RingApiInstance = InstanceType<RingClientApiModule['RingApi']>
type RingRestClientInstance = InstanceType<RingRestClientModule['RingRestClient']>
type RingCameraInstance = Awaited<ReturnType<RingApiInstance['getCameras']>>[number]
type RingLocationInstance = Awaited<ReturnType<RingApiInstance['getLocations']>>[number]
type RingDeviceInstance = Awaited<ReturnType<RingLocationInstance['getDevices']>>[number]

// Load ESM-only ring-client-api reliably from CommonJS Electron main & app.asar
const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>

const importRingClientApi = async (): Promise<RingClientApiModule> => {
  try {
    const resolved = require.resolve('ring-client-api')
    return (await dynamicImport(pathToFileURL(resolved).href)) as RingClientApiModule
  } catch {
    return (await dynamicImport('ring-client-api')) as RingClientApiModule
  }
}

const importRingRestClient = async (): Promise<RingRestClientModule> => {
  try {
    const resolved = require.resolve('ring-client-api/rest-client')
    return (await dynamicImport(pathToFileURL(resolved).href)) as RingRestClientModule
  } catch {
    return (await dynamicImport('ring-client-api/rest-client')) as RingRestClientModule
  }
}

function classifySensorCategory(deviceType: string): SensorCategory {
  const dt = deviceType.toLowerCase()
  if (dt.includes('contact')) return 'contact'
  if (dt.includes('motion')) return 'motion'
  if (dt.includes('flood') || dt.includes('freeze')) return 'flood'
  if (dt.includes('smoke') || dt.includes('co')) return 'smoke'
  if (dt.includes('keypad')) return 'keypad'
  if (dt.includes('lock')) return 'lock'
  if (dt.includes('light') || dt.includes('switch') || dt.includes('beam')) return 'light'
  if (dt.includes('hub') || dt.includes('security-panel')) return 'base-station'
  return 'other'
}

function deriveSensorStatusLabel(
  category: SensorCategory,
  faulted: boolean,
  mode?: string,
  online = true,
): string {
  if (!online) return 'Offline'
  if (category === 'contact') return faulted ? 'Open' : 'Closed'
  if (category === 'motion') return faulted ? 'Motion Active' : 'Clear'
  if (category === 'flood') return faulted ? 'Water / Freeze Alert' : 'Dry'
  if (category === 'smoke') return faulted ? 'Alarm Active' : 'Clear'
  if (category === 'keypad') return mode ? `Mode: ${mode}` : 'Ready'
  if (category === 'lock') return faulted ? 'Unlocked' : 'Locked'
  return faulted ? 'Triggered' : 'Normal'
}

export interface RingServiceCallbacks {
  onConnectionChanged: (status: ConnectionStatus) => void
  onSettingsUpdated?: (settings: AppSettings) => void
  onCamerasUpdated: (cameras: RingCameraInfo[]) => void
  onSensorsUpdated: (sensors: RingSensorInfo[]) => void
  onLocationsUpdated: (locations: RingLocationInfo[]) => void
  onSecurityEvent: (event: SecurityEvent) => void
  onEventsUpdated?: (events: SecurityEvent[]) => void
  onNvrStatusUpdated?: (status: NvrStatus) => void
  onRecordingsUpdated: (recordings: LocalRecordingItem[]) => void
  onStorageStatsUpdated: (stats: import('../../shared/types').StorageStats) => void
}

interface NvrWorker {
  cameraId: string
  cameraName: string
  stopped: boolean
  state: NvrCameraStatus['state']
  startedAt: string
  currentSegmentStartedAt?: string
  lastSegmentAt?: string
  lastActivityMs: number
  segmentsCaptured: number
  reconnectCount: number
  bytesRecorded: number
  estimatedBitrateKbps?: number
  consecutiveFailures: number
  offlineNotified: boolean
  lastError?: string
  activeCall?: { stop(): void }
  cancelWait?: () => void
  promise?: Promise<void>
}

export class RingService implements SnapshotSource {
  private readonly configStore: ConfigStore
  private readonly streamService: StreamService
  private readonly recordingService: RecordingService
  private readonly aiPackageService: AiPackageService
  private readonly notifications?: NotificationService
  private readonly onPowerSaveChange?: (shouldBlock: boolean) => void
  private readonly callbacks: RingServiceCallbacks
  private readonly demoAssetsDir: string
  private readonly eventsLogPath: string | null

  private ringApi: RingApiInstance | null = null
  private pendingAuthClient: RingRestClientInstance | null = null
  private subscriptions: Subscription[] = []
  private liveCamerasById = new Map<string, RingCameraInstance>()
  private liveLocationsById = new Map<string, RingLocationInstance>()
  private boundSensorZids = new Set<string>()
  private recordingCameraIds = new Set<string>()
  private nvrWorkers = new Map<string, NvrWorker>()
  private nvrStartedAt: string | undefined
  private nvrTotalSegmentsCaptured = 0
  private nvrWatchdogTimer: NodeJS.Timeout | null = null
  private nvrWatchdogChecks = 0
  private nvrLastHealthCheckAt: string | undefined
  private powerSaveBlocked = false
  private lastKnownDiskHealth: DiskHealthStatus = 'healthy'
  private lastKnownUsingFailover = false
  private lastLowDiskNotifiedAt = 0
  private lastCriticalDiskNotifiedAt = 0
  private lastFailoverNotifiedAt = 0
  private snapshotCache = new Map<string, { dataUrl: string; capturedAt: string }>()

  private connection: ConnectionStatus = {
    connected: true,
    mode: 'demo',
    accountLabel: 'Demo Mode (Simulated Home)',
    locationCount: 1,
    cameraCount: 3,
    sensorCount: 5,
    lastSyncAt: new Date().toISOString(),
  }

  private locations: RingLocationInfo[] = []
  private cameras: RingCameraInfo[] = []
  private sensors: RingSensorInfo[] = []
  private events: SecurityEvent[] = []

  constructor(params: {
    userDataDir?: string
    configStore: ConfigStore
    streamService: StreamService
    recordingService: RecordingService
    aiPackageService: AiPackageService
    notifications?: NotificationService
    onPowerSaveChange?: (shouldBlock: boolean) => void
    demoAssetsDir: string
    callbacks: RingServiceCallbacks
  }) {
    this.configStore = params.configStore
    this.streamService = params.streamService
    this.recordingService = params.recordingService
    this.aiPackageService = params.aiPackageService
    this.notifications = params.notifications
    this.onPowerSaveChange = params.onPowerSaveChange
    this.demoAssetsDir = params.demoAssetsDir
    this.callbacks = params.callbacks
    this.eventsLogPath = params.userDataDir
      ? path.join(params.userDataDir, 'events-log.json')
      : null
    this.events = this.loadEventsFromDisk()
  }

  private loadEventsFromDisk(): SecurityEvent[] {
    if (!this.eventsLogPath || !fs.existsSync(this.eventsLogPath)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.eventsLogPath, 'utf-8'))
      if (!Array.isArray(parsed)) return []
      return parsed.slice(0, 500)
    } catch {
      return []
    }
  }

  private saveEventsToDisk(): void {
    if (!this.eventsLogPath) return
    try {
      // Omit large inline base64 snapshots when persisting to keep events-log.json fast and compact
      const slim = this.events.slice(0, 500).map((ev) => {
        if (ev.snapshotDataUrl && ev.snapshotDataUrl.startsWith('data:')) {
          const { snapshotDataUrl: _drop, ...rest } = ev
          return rest
        }
        return ev
      })
      fs.writeFileSync(this.eventsLogPath, JSON.stringify(slim, null, 2), 'utf-8')
    } catch {
      // Ignore write failures
    }
  }

  async initialize(): Promise<void> {
    await this.streamService.startServer()
    this.aiPackageService.attachSnapshotSource(this)
    this.startNvrWatchdog()

    const settings = this.configStore.getPublicSettings()
    const savedToken = this.configStore.getRingRefreshToken()

    if (settings.mode === 'live' && savedToken) {
      await this.connectWithToken(savedToken)
    } else {
      this.activateDemoMode()
    }
  }

  getConnection(): ConnectionStatus {
    return { ...this.connection }
  }

  getLocations(): RingLocationInfo[] {
    return [...this.locations]
  }

  private isCameraNvrActive(cameraId: string): boolean {
    const w = this.nvrWorkers.get(cameraId)
    return Boolean(
      w &&
        !w.stopped &&
        (w.state === 'recording' ||
          w.state === 'connecting' ||
          w.state === 'reconnecting' ||
          w.state === 'stalled'),
    )
  }

  getCameras(): RingCameraInfo[] {
    return this.cameras.map((cam) => ({
      ...cam,
      isStreaming: this.streamService.isStreaming(cam.id),
      isRecording:
        this.recordingCameraIds.has(cam.id) || this.isCameraNvrActive(cam.id),
    }))
  }

  getSensors(): RingSensorInfo[] {
    return [...this.sensors]
  }

  getEvents(): SecurityEvent[] {
    return [...this.events]
  }

  private getActiveNvrCameraCount(): number {
    let count = 0
    for (const w of this.nvrWorkers.values()) {
      if (!w.stopped) count++
    }
    return count
  }

  private syncPowerSaveBlocker(): void {
    const settings = this.configStore.getPublicSettings()
    const shouldBlock =
      this.getActiveNvrCameraCount() > 0 && settings.preventSleepWhileRecording
    if (shouldBlock !== this.powerSaveBlocked) {
      this.powerSaveBlocked = shouldBlock
      this.onPowerSaveChange?.(shouldBlock)
    }
  }

  syncNvrSettings(): void {
    this.syncPowerSaveBlocker()
    this.runNvrHealthCheck()
  }

  private startNvrWatchdog(): void {
    this.stopNvrWatchdog()
    this.runNvrHealthCheck()
    this.nvrWatchdogTimer = setInterval(() => {
      this.runNvrHealthCheck()
    }, 30_000)
  }

  private stopNvrWatchdog(): void {
    if (this.nvrWatchdogTimer) {
      clearInterval(this.nvrWatchdogTimer)
      this.nvrWatchdogTimer = null
    }
  }

  runNvrHealthCheck(): void {
    this.nvrWatchdogChecks++
    this.nvrLastHealthCheckAt = new Date().toISOString()

    const settings = this.configStore.getPublicSettings()
    let stats = this.recordingService.getStorageStats()
    const nowMs = Date.now()

    // 1. Detect Primary Storage Offline -> Failover or Restore transitions
    if (stats.usingFailover && !this.lastKnownUsingFailover) {
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: this.nvrLastHealthCheckAt,
        sourceType: 'system',
        deviceName: 'RingWatch Storage',
        kind: 'storage-alert',
        title: 'Primary Storage Offline — Failover Active',
        detail: `Primary vault (${stats.recordingsDir}) is unavailable. Recording automatically failed over to ${stats.activeRecordingsDir}.`,
        severity: 'alert',
      })
      if (nowMs - this.lastFailoverNotifiedAt > 5 * 60 * 1000) {
        this.lastFailoverNotifiedAt = nowMs
        this.notifications?.notifyNvrAlert({
          title: 'RingWatch NVR — Storage Failover Active',
          body: `Primary drive offline. Recording seamlessly to failover folder: ${stats.activeRecordingsDir}`,
          severity: 'critical',
          desktopEnabled: settings.nvrNotificationsEnabled,
        })
      }
    } else if (!stats.usingFailover && this.lastKnownUsingFailover) {
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: this.nvrLastHealthCheckAt,
        sourceType: 'system',
        deviceName: 'RingWatch Storage',
        kind: 'storage-alert',
        title: 'Primary Storage Restored',
        detail: `Primary vault (${stats.recordingsDir}) is back online and writable.`,
        severity: 'success',
      })
      this.notifications?.notifyNvrAlert({
        title: 'RingWatch NVR — Primary Storage Restored',
        body: `Primary storage drive is back online: ${stats.recordingsDir}`,
        severity: 'info',
        desktopEnabled: settings.nvrNotificationsEnabled,
      })
    }
    this.lastKnownUsingFailover = stats.usingFailover

    // 2. Enforce Free-Disk Floor & emit rate-limited Low Disk Space notifications
    const freeGb =
      stats.freeDiskBytes !== null
        ? Number((stats.freeDiskBytes / (1024 * 1024 * 1024)).toFixed(1))
        : null

    if (stats.diskHealth === 'critical') {
      const pruned = this.recordingService.enforceRetentionAndQuota()
      stats = pruned.stats
      if (pruned.prunedCount > 0) {
        this.callbacks.onRecordingsUpdated(this.recordingService.listRecordings())
        this.pushEvent({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sourceType: 'system',
          deviceName: 'RingWatch Storage',
          kind: 'storage-alert',
          title: `Auto-Pruned ${pruned.prunedCount} Clip(s) — Low Disk Floor`,
          detail: `Reclaimed ${(pruned.freedBytes / (1024 * 1024)).toFixed(1)} MB to keep at least ${settings.minFreeDiskGb} GB free.`,
          severity: 'warning',
        })
      }

      if (
        (stats.diskHealth === 'critical' || stats.diskHealth === 'warning') &&
        nowMs - this.lastCriticalDiskNotifiedAt > 15 * 60 * 1000
      ) {
        this.lastCriticalDiskNotifiedAt = nowMs
        const updatedFreeGb =
          stats.freeDiskBytes !== null
            ? (stats.freeDiskBytes / (1024 * 1024 * 1024)).toFixed(1)
            : '0'
        this.pushEvent({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sourceType: 'system',
          deviceName: 'RingWatch Storage',
          kind: 'storage-alert',
          title: `Critical Disk Space — ${updatedFreeGb} GB Free`,
          detail: `Drive free space is below the ${settings.minFreeDiskGb} GB safety floor. Consider attaching a larger external drive or lowering protected clips.`,
          severity: 'alert',
        })
        this.notifications?.notifyNvrAlert({
          title: `RingWatch NVR — Critical Disk Space (${updatedFreeGb} GB Free)`,
          body: `Storage is below the ${settings.minFreeDiskGb} GB floor. Oldest unstarred clips are being recycled automatically.`,
          severity: 'critical',
          desktopEnabled: settings.nvrNotificationsEnabled,
        })
      }
    } else if (
      stats.diskHealth === 'warning' &&
      stats.primaryOnline &&
      freeGb !== null &&
      nowMs - this.lastLowDiskNotifiedAt > 60 * 60 * 1000
    ) {
      this.lastLowDiskNotifiedAt = nowMs
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sourceType: 'system',
        deviceName: 'RingWatch Storage',
        kind: 'storage-alert',
        title: `Low Disk Space Warning — ${freeGb} GB Free`,
        detail: `Drive free space dropped below your ${settings.lowDiskWarningGb} GB warning threshold.`,
        severity: 'warning',
      })
      this.notifications?.notifyNvrAlert({
        title: `RingWatch NVR — Low Disk Space (${freeGb} GB Free)`,
        body: `Free space is below ${settings.lowDiskWarningGb} GB on ${stats.activeRecordingsDir}.`,
        severity: 'warning',
        desktopEnabled: settings.nvrNotificationsEnabled,
      })
    }
    this.lastKnownDiskHealth = stats.diskHealth

    // 3. Stalled Stream Self-Healing Watchdog (Live Mode)
    if (this.connection.mode === 'live') {
      const stallTimeoutMs =
        Math.max(settings.continuousSegmentSeconds * 2 + 60, 240) * 1000
      for (const worker of this.nvrWorkers.values()) {
        if (worker.stopped || worker.state !== 'recording') continue
        if (nowMs - worker.lastActivityMs > stallTimeoutMs) {
          worker.state = 'stalled'
          worker.lastError = `Stream stalled for ${Math.round((nowMs - worker.lastActivityMs) / 1000)}s — restarting automatically`
          worker.lastActivityMs = nowMs
          try {
            worker.activeCall?.stop()
          } catch {
            // ignore stop errors
          }
          this.pushEvent({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            sourceType: 'camera',
            deviceId: worker.cameraId,
            deviceName: worker.cameraName,
            kind: 'nvr-health',
            title: `Watchdog Restarted Stream — ${worker.cameraName}`,
            detail: 'No new video segments arrived within watchdog window; reconnecting live feed.',
            severity: 'warning',
          })
        }
      }
    }

    this.syncPowerSaveBlocker()
    this.callbacks.onStorageStatsUpdated(stats)
    this.callbacks.onNvrStatusUpdated?.(this.getNvrStatus())
  }

  getNvrStatus(): NvrStatus {
    const camerasStatus: Record<string, NvrCameraStatus> = {}
    let activeCameraCount = 0
    for (const [camId, w] of this.nvrWorkers.entries()) {
      if (!w.stopped) activeCameraCount++
      camerasStatus[camId] = {
        cameraId: w.cameraId,
        cameraName: w.cameraName,
        state: w.state,
        startedAt: w.startedAt,
        currentSegmentStartedAt: w.currentSegmentStartedAt,
        lastSegmentAt: w.lastSegmentAt,
        segmentsCaptured: w.segmentsCaptured,
        reconnectCount: w.reconnectCount,
        bytesRecorded: w.bytesRecorded,
        estimatedBitrateKbps: w.estimatedBitrateKbps,
        lastError: w.lastError,
      }
    }
    return {
      active: activeCameraCount > 0,
      startedAt: activeCameraCount > 0 ? this.nvrStartedAt : undefined,
      segmentSeconds: this.configStore.getPublicSettings().continuousSegmentSeconds,
      totalSegmentsCaptured: this.nvrTotalSegmentsCaptured,
      activeCameraCount,
      powerSaveBlocked: this.powerSaveBlocked,
      usingFailoverStorage: this.lastKnownUsingFailover,
      diskHealth: this.lastKnownDiskHealth,
      watchdogChecks: this.nvrWatchdogChecks,
      lastHealthCheckAt: this.nvrLastHealthCheckAt,
      cameras: camerasStatus,
    }
  }

  private emitNvrStatus(): void {
    this.syncPowerSaveBlocker()
    this.callbacks.onNvrStatusUpdated?.(this.getNvrStatus())
    this.callbacks.onCamerasUpdated(this.getCameras())
  }

  getCameraMeta(cameraId: string): { id: string; name: string } | undefined {
    const cam = this.cameras.find((c) => c.id === cameraId)
    return cam ? { id: cam.id, name: cam.name } : undefined
  }

  listCameraIds(): string[] {
    return this.cameras.map((c) => c.id)
  }

  recordExternalEvent(event: SecurityEvent): void {
    this.pushEvent(event)
  }

  private pushEvent(event: SecurityEvent): void {
    if (this.events.some((e) => e.id === event.id)) return
    this.events.unshift(event)
    this.events = this.events.slice(0, 500)
    this.saveEventsToDisk()
    this.callbacks.onSecurityEvent(event)
  }

  private stopAllNvrWorkersSync(): void {
    for (const worker of this.nvrWorkers.values()) {
      worker.stopped = true
      worker.state = 'stopped'
      worker.cancelWait?.()
      try {
        worker.activeCall?.stop()
      } catch {
        // ignore
      }
    }
    this.nvrWorkers.clear()
    this.nvrStartedAt = undefined
  }

  private clearLiveSubscriptions(): void {
    this.stopAllNvrWorkersSync()
    for (const sub of this.subscriptions) {
      try {
        sub.unsubscribe()
      } catch {
        // ignore
      }
    }
    this.subscriptions = []
    this.streamService.stopAll()
    if (this.ringApi) {
      try {
        this.ringApi.disconnect()
      } catch {
        // ignore
      }
      this.ringApi = null
    }
    this.liveCamerasById.clear()
    this.liveLocationsById.clear()
    this.boundSensorZids.clear()
    this.callbacks.onNvrStatusUpdated?.(this.getNvrStatus())
  }

  private readDemoImageDataUrl(filename: string): string {
    const full = path.join(this.demoAssetsDir, filename)
    if (!fs.existsSync(full)) return ''
    const buf = fs.readFileSync(full)
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  }

  activateDemoMode(): ConnectionStatus {
    this.clearLiveSubscriptions()
    this.configStore.updateSettings({ mode: 'demo' })

    const now = new Date().toISOString()
    const frontSnap = this.readDemoImageDataUrl('front_porch.jpg')
    const driveSnap = this.readDemoImageDataUrl('driveway.jpg')
    const patioSnap = this.readDemoImageDataUrl('back_patio.jpg')

    this.locations = [
      {
        id: 'demo-loc-home',
        name: 'Maple Street Home',
        hasAlarm: true,
        alarmMode: 'none',
      },
    ]

    this.cameras = [
      {
        id: 'demo-cam-front',
        name: 'Front Porch Doorbell Pro',
        locationId: 'demo-loc-home',
        locationName: 'Maple Street Home',
        model: 'Video Doorbell Pro 2',
        kind: 'doorbot_v4',
        online: true,
        batteryPercent: null,
        rssi: -46,
        hasLight: false,
        lightOn: false,
        hasSiren: false,
        sirenOn: false,
        isDoorbell: true,
        isStreaming: false,
        isRecording: false,
        lastSnapshotDataUrl: frontSnap,
        lastSnapshotAt: now,
        lastMotionAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        demoImage: 'front_porch.jpg',
      },
      {
        id: 'demo-cam-driveway',
        name: 'Driveway Floodlight Cam',
        locationId: 'demo-loc-home',
        locationName: 'Maple Street Home',
        model: 'Floodlight Cam Wired Pro',
        kind: 'floodlight_v2',
        online: true,
        batteryPercent: null,
        rssi: -53,
        hasLight: true,
        lightOn: false,
        hasSiren: true,
        sirenOn: false,
        isDoorbell: false,
        isStreaming: false,
        isRecording: false,
        lastSnapshotDataUrl: driveSnap,
        lastSnapshotAt: now,
        lastMotionAt: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
        demoImage: 'driveway.jpg',
      },
      {
        id: 'demo-cam-patio',
        name: 'Back Patio Stick Up Cam',
        locationId: 'demo-loc-home',
        locationName: 'Maple Street Home',
        model: 'Stick Up Cam Battery',
        kind: 'stickup_cam_v4',
        online: true,
        batteryPercent: 84,
        rssi: -60,
        hasLight: false,
        lightOn: false,
        hasSiren: true,
        sirenOn: false,
        isDoorbell: false,
        isStreaming: false,
        isRecording: false,
        lastSnapshotDataUrl: patioSnap,
        lastSnapshotAt: now,
        demoImage: 'back_patio.jpg',
      },
    ]

    this.sensors = [
      {
        id: 'demo-sensor-front-door',
        zid: 'demo-sensor-front-door',
        name: 'Front Door Contact',
        locationId: 'demo-loc-home',
        locationName: 'Maple Street Home',
        deviceType: 'sensor.contact',
        category: 'contact',
        faulted: false,
        tamper: false,
        batteryPercent: 96,
        online: true,
        statusLabel: 'Closed',
        lastUpdatedAt: now,
      },
      {
        id: 'demo-sensor-living-motion',
        zid: 'demo-sensor-living-motion',
        name: 'Living Room Motion',
        locationId: 'demo-loc-home',
        locationName: 'Maple Street Home',
        deviceType: 'sensor.motion',
        category: 'motion',
        faulted: false,
        tamper: false,
        batteryPercent: 91,
        online: true,
        statusLabel: 'Clear',
        lastUpdatedAt: now,
      },
      {
        id: 'demo-sensor-garage',
        zid: 'demo-sensor-garage',
        name: 'Garage Entry Door',
        locationId: 'demo-loc-home',
        locationName: 'Maple Street Home',
        deviceType: 'sensor.contact',
        category: 'contact',
        faulted: false,
        tamper: false,
        batteryPercent: 88,
        online: true,
        statusLabel: 'Closed',
        lastUpdatedAt: now,
      },
      {
        id: 'demo-sensor-basement-flood',
        zid: 'demo-sensor-basement-flood',
        name: 'Basement Flood & Freeze',
        locationId: 'demo-loc-home',
        locationName: 'Maple Street Home',
        deviceType: 'sensor.flood-freeze',
        category: 'flood',
        faulted: false,
        tamper: false,
        batteryPercent: 100,
        online: true,
        statusLabel: 'Dry',
        lastUpdatedAt: now,
      },
      {
        id: 'demo-sensor-keypad',
        zid: 'demo-sensor-keypad',
        name: 'Hallway Alarm Keypad',
        locationId: 'demo-loc-home',
        locationName: 'Maple Street Home',
        deviceType: 'security-keypad',
        category: 'keypad',
        faulted: false,
        tamper: false,
        batteryPercent: 78,
        online: true,
        statusLabel: 'Ready',
        lastUpdatedAt: now,
      },
    ]

    if (this.events.length === 0) {
      this.events = [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
          sourceType: 'camera',
          deviceId: 'demo-cam-front',
          deviceName: 'Front Porch Doorbell Pro',
          kind: 'motion',
          title: 'Motion Detected — Front Porch',
          detail: 'Person approached porch entrance; snapshot refreshed.',
          severity: 'warning',
          snapshotDataUrl: frontSnap,
        },
        {
          id: crypto.randomUUID(),
          timestamp: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
          sourceType: 'sensor',
          deviceId: 'demo-sensor-garage',
          deviceName: 'Garage Entry Door',
          kind: 'contact-close',
          title: 'Garage Entry Door Closed',
          detail: 'Contact sensor returned to closed state.',
          severity: 'info',
        },
        {
          id: crypto.randomUUID(),
          timestamp: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
          sourceType: 'system',
          deviceName: 'RingWatch Engine',
          kind: 'info',
          title: 'Demo Mode Active',
          detail:
            'Explore live camera preview, local MP4 capture, sensor telemetry, and AI package scans — or connect your Ring account in Settings.',
          severity: 'info',
        },
      ]
    }

    this.connection = {
      connected: true,
      mode: 'demo',
      accountLabel: 'Demo Mode (Simulated Home)',
      locationCount: this.locations.length,
      cameraCount: this.cameras.length,
      sensorCount: this.sensors.length,
      lastSyncAt: now,
    }

    this.emitAllState()

    // Seed playable local demo clips on first launch so Timeline & Local Vault are immediately populated
    void this.recordingService
      .seedDemoClipsIfEmpty(this.demoAssetsDir, [
        {
          cameraId: 'demo-cam-front',
          cameraName: 'Front Porch Doorbell Pro',
          demoImage: 'front_porch.jpg',
          trigger: 'package',
          minutesAgo: 12,
          durationSeconds: 32,
          starred: true,
        },
        {
          cameraId: 'demo-cam-driveway',
          cameraName: 'Driveway Floodlight Cam',
          demoImage: 'driveway.jpg',
          trigger: 'motion',
          minutesAgo: 48,
          durationSeconds: 26,
        },
        {
          cameraId: 'demo-cam-front',
          cameraName: 'Front Porch Doorbell Pro',
          demoImage: 'front_porch.jpg',
          trigger: 'ding',
          minutesAgo: 115,
          durationSeconds: 40,
        },
        {
          cameraId: 'demo-cam-patio',
          cameraName: 'Back Patio Stick Up Cam',
          demoImage: 'back_patio.jpg',
          trigger: 'motion',
          minutesAgo: 185,
          durationSeconds: 20,
        },
      ])
      .then((recs) => {
        this.callbacks.onRecordingsUpdated(recs)
        this.callbacks.onStorageStatsUpdated(this.recordingService.getStorageStats())
      })
      .catch(() => {})

    if (this.configStore.getPublicSettings().continuousAutoStart) {
      void this.startAllCameraRecording().catch(() => {})
    }

    return this.getConnection()
  }

  async switchMode(mode: AppMode): Promise<ConnectionStatus> {
    if (mode === 'demo') {
      return this.activateDemoMode()
    }
    const token = this.configStore.getRingRefreshToken()
    if (!token) {
      this.clearLiveSubscriptions()
      this.locations = []
      this.cameras = []
      this.sensors = []
      this.connection = {
        connected: false,
        mode: 'live',
        locationCount: 0,
        cameraCount: 0,
        sensorCount: 0,
        error: 'Sign in with your Ring account or paste a Ring refresh token in Settings.',
      }
      this.configStore.updateSettings({ mode: 'live' })
      this.emitAllState()
      return this.getConnection()
    }
    return this.connectWithToken(token)
  }

  async loginWithCredentials(params: {
    email: string
    password: string
    twoFactorCode?: string
  }): Promise<RingAuthStepResult> {
    try {
      const { RingRestClient } = await importRingRestClient()

      if (!params.twoFactorCode || !this.pendingAuthClient) {
        this.pendingAuthClient = new RingRestClient({
          email: params.email.trim(),
          password: params.password,
          systemId: this.configStore.getRingSystemId(),
          controlCenterDisplayName: 'RingWatch Windows',
        })
      }

      try {
        const auth = await this.pendingAuthClient.getAuth(
          params.twoFactorCode?.trim() || undefined,
        )
        if (auth.refresh_token) {
          this.pendingAuthClient = null
          const connection = await this.connectWithToken(auth.refresh_token)
          if (!connection.connected) {
            return {
              status: 'error',
              error:
                connection.error ??
                'Signed in to Ring, but failed to load your cameras and devices.',
              connection,
            }
          }
          return { status: 'authenticated', connection }
        }
        return {
          status: 'error',
          error: 'Ring did not return a refresh token.',
        }
      } catch (err) {
        if (this.pendingAuthClient?.using2fa) {
          return {
            status: '2fa-required',
            prompt:
              this.pendingAuthClient.promptFor2fa ??
              'Enter the 2FA verification code sent by Ring.',
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { status: 'error', error: msg }
      }
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async connectWithToken(refreshToken: string): Promise<ConnectionStatus> {
    this.clearLiveSubscriptions()
    await this.streamService.startServer()

    const trimmed = refreshToken.trim()
    if (!trimmed) {
      throw new Error('Refresh token cannot be empty')
    }

    // Clear any Demo Mode devices immediately so stale demo cards never persist in Live Mode
    this.locations = []
    this.cameras = []
    this.sensors = []

    try {
      const { RingApi } = await importRingClientApi()
      const ffmpegPath = this.recordingService.resolveFfmpegBinary()
      const systemId = this.configStore.getRingSystemId()
      const api = new RingApi({
        refreshToken: trimmed,
        systemId,
        controlCenterDisplayName: 'RingWatch Windows',
        cameraStatusPollingSeconds: 20,
        locationModePollingSeconds: 30,
        ffmpegPath,
      })

      this.ringApi = api
      this.configStore.setRingRefreshToken(trimmed)
      this.configStore.updateSettings({ mode: 'live' })
      this.callbacks.onSettingsUpdated?.(this.configStore.getPublicSettings())

      const tokenSub = api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
        if (newRefreshToken) {
          this.configStore.setRingRefreshToken(newRefreshToken)
        }
      })
      this.subscriptions.push(tokenSub)

      await this.syncLiveRingAccount(api)
      return this.getConnection()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.locations = []
      this.cameras = []
      this.sensors = []
      this.connection = {
        connected: false,
        mode: 'live',
        locationCount: 0,
        cameraCount: 0,
        sensorCount: 0,
        error: message,
      }
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sourceType: 'system',
        deviceName: 'Ring Cloud',
        kind: 'info',
        title: 'Ring Connection Error',
        detail: message,
        severity: 'alert',
      })
      this.emitAllState()
      return this.getConnection()
    }
  }

  async disconnectRing(): Promise<ConnectionStatus> {
    this.configStore.setRingRefreshToken(null)
    return this.activateDemoMode()
  }

  private upsertLocationSensors(
    loc: RingLocationInstance,
    devices: RingDeviceInstance[],
  ): void {
    const mappedForLoc: RingSensorInfo[] = []
    let detectedAlarmMode: AlarmMode | null = null

    for (const dev of devices) {
      const mapped = this.mapLiveSensor(dev, loc.id, loc.name)
      mappedForLoc.push(mapped)

      const rawData = dev.data as unknown as Record<string, unknown>
      if (
        String(dev.deviceType) === 'security-panel' &&
        typeof rawData.mode === 'string' &&
        (rawData.mode === 'none' || rawData.mode === 'some' || rawData.mode === 'all')
      ) {
        detectedAlarmMode = rawData.mode
      }

      if (!this.boundSensorZids.has(dev.zid)) {
        this.boundSensorZids.add(dev.zid)
        this.bindSensorSubscription(dev, loc.id, loc.name)
      }
    }

    const otherLocSensors = this.sensors.filter((s) => s.locationId !== loc.id)
    this.sensors = [...otherLocSensors, ...mappedForLoc]

    if (detectedAlarmMode) {
      this.locations = this.locations.map((l) =>
        l.id === loc.id ? { ...l, alarmMode: detectedAlarmMode! } : l,
      )
      this.callbacks.onLocationsUpdated(this.getLocations())
    }

    this.connection = {
      ...this.connection,
      sensorCount: this.sensors.length,
      lastSyncAt: new Date().toISOString(),
    }
    this.callbacks.onSensorsUpdated(this.getSensors())
    this.callbacks.onConnectionChanged(this.getConnection())
  }

  private async syncLiveRingAccount(api: RingApiInstance): Promise<void> {
    let accountLabel = 'Ring Account Connected'
    try {
      const profile = await api.getProfile()
      const email = (profile as { profile?: { email?: string } }).profile?.email
      if (email) accountLabel = email
    } catch {
      // Optional profile label
    }

    const rawLocations = await api.getLocations()
    this.liveLocationsById.clear()
    this.liveCamerasById.clear()
    this.boundSensorZids.clear()

    const nextLocations: RingLocationInfo[] = []
    const nextCameras: RingCameraInfo[] = []
    const hubLocations: RingLocationInstance[] = []

    for (const loc of rawLocations) {
      this.liveLocationsById.set(loc.id, loc)

      nextLocations.push({
        id: loc.id,
        name: loc.name,
        hasAlarm: loc.hasAlarmBaseStation,
        alarmMode: 'unknown',
      })

      for (const cam of loc.cameras) {
        const camId = String(cam.id)
        this.liveCamerasById.set(camId, cam)
        nextCameras.push(this.mapLiveCamera(cam, loc.id, loc.name))
        this.bindCameraSubscriptions(cam, loc.id, loc.name)
      }

      if (loc.hasHubs || loc.hasAlarmBaseStation) {
        hubLocations.push(loc)
      }
    }

    // Publish locations & cameras immediately so UI is responsive even if an Alarm hub WebSocket is slow
    this.locations = nextLocations
    this.cameras = nextCameras
    this.sensors = []
    this.connection = {
      connected: true,
      mode: 'live',
      accountLabel,
      locationCount: nextLocations.length,
      cameraCount: nextCameras.length,
      sensorCount: 0,
      lastSyncAt: new Date().toISOString(),
    }
    this.emitAllState()

    // Subscribe reactively to hub/alarm sensor device lists and wait up to 12s for initial load
    if (hubLocations.length > 0) {
      await Promise.allSettled(
        hubLocations.map(async (loc) => {
          this.subscriptions.push(
            loc.onDevices.subscribe((devices) => {
              this.upsertLocationSensors(loc, devices)
            }),
          )

          try {
            const devices = await Promise.race([
              loc.getDevices(),
              new Promise<RingDeviceInstance[]>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Timed out loading sensors for ${loc.name}`)),
                  12000,
                ),
              ),
            ])
            this.upsertLocationSensors(loc, devices)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this.pushEvent({
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              sourceType: 'sensor',
              deviceId: loc.id,
              deviceName: loc.name,
              kind: 'info',
              title: `Hub Sensor Sync Pending — ${loc.name}`,
              detail: `${msg}. RingWatch will continue listening in the background.`,
              severity: 'warning',
            })
          }
        }),
      )
    }

    this.pushEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sourceType: 'system',
      deviceName: 'Ring Cloud',
      kind: 'info',
      title: 'Connected to Ring Account',
      detail: `Loaded ${this.cameras.length} camera(s) and ${this.sensors.length} sensor/device(s) across ${this.locations.length} location(s).`,
      severity: 'success',
    })

    this.emitAllState()

    // Fetch initial snapshots lazily in background
    for (const cam of this.cameras) {
      void this.captureSnapshot(cam.id).catch(() => {})
    }

    // Pull recent Ring Cloud camera events onto the Timeline lazily
    void this.syncCloudEventsToTimeline().catch(() => {})

    // Auto-start all-camera continuous NVR recording if enabled in Settings
    if (
      this.configStore.getPublicSettings().continuousAutoStart &&
      this.cameras.length > 0
    ) {
      void this.startAllCameraRecording().catch(() => {})
    }
  }

  private mapLiveCamera(
    cam: RingCameraInstance,
    locationId: string,
    locationName: string,
  ): RingCameraInfo {
    const camId = String(cam.id)
    const cached = this.snapshotCache.get(camId)
    const data = cam.data as unknown as Record<string, unknown>
    const health = (data.health ?? {}) as Record<string, unknown>
    const ledStatus = data.led_status
    const sirenStatus = (data.siren_status ?? {}) as Record<string, unknown>

    return {
      id: camId,
      name: cam.name,
      locationId,
      locationName,
      model: cam.model || String(cam.deviceType),
      kind: String(cam.deviceType),
      online: !cam.isOffline,
      batteryPercent: cam.batteryLevel,
      rssi:
        typeof health.latest_signal_strength === 'number'
          ? health.latest_signal_strength
          : null,
      hasLight: cam.hasLight,
      lightOn: ledStatus === 'on',
      hasSiren: cam.hasSiren,
      sirenOn: Number(sirenStatus.seconds_remaining ?? 0) > 0,
      isDoorbell: cam.isDoorbot,
      isStreaming: this.streamService.isStreaming(camId),
      isRecording:
        this.recordingCameraIds.has(camId) || this.isCameraNvrActive(camId),
      lastSnapshotDataUrl: cached?.dataUrl,
      lastSnapshotAt: cached?.capturedAt,
    }
  }

  private mapLiveSensor(
    dev: RingDeviceInstance,
    locationId: string,
    locationName: string,
  ): RingSensorInfo {
    const data = dev.data as unknown as Record<string, unknown>
    const category = classifySensorCategory(String(dev.deviceType))
    const faulted = Boolean(data.faulted)
    const tamper = data.tamperStatus === 'tamper'
    const batteryPercent =
      typeof data.batteryLevel === 'number' ? data.batteryLevel : null
    const online = data.commStatus !== 'error'
    const mode = typeof data.mode === 'string' ? data.mode : undefined

    return {
      id: dev.zid,
      zid: dev.zid,
      name: dev.name,
      locationId,
      locationName,
      deviceType: String(dev.deviceType),
      category,
      faulted,
      tamper,
      batteryPercent,
      batteryStatus:
        typeof data.batteryStatus === 'string' ? data.batteryStatus : undefined,
      online,
      statusLabel: deriveSensorStatusLabel(category, faulted, mode, online),
      lastUpdatedAt: new Date().toISOString(),
    }
  }

  private bindCameraSubscriptions(
    cam: RingCameraInstance,
    locationId: string,
    locationName: string,
  ): void {
    const camId = String(cam.id)

    this.subscriptions.push(
      cam.onData.subscribe(() => {
        const updated = this.mapLiveCamera(cam, locationId, locationName)
        this.cameras = this.cameras.map((c) => (c.id === camId ? updated : c))
        this.callbacks.onCamerasUpdated(this.getCameras())
      }),
    )

    this.subscriptions.push(
      cam.onDoorbellPressed.subscribe(() => {
        this.pushEvent({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sourceType: 'camera',
          deviceId: camId,
          deviceName: cam.name,
          kind: 'ding',
          title: `Doorbell Pressed — ${cam.name}`,
          detail: 'Visitor pressed the doorbell button.',
          severity: 'alert',
        })
        void this.aiPackageService.handleAutoTrigger(camId, 'doorbell')
        void this.autoCaptureIfEnabled(camId, 'ding')
      }),
    )

    let lastMotionState = false
    this.subscriptions.push(
      cam.onMotionDetected.subscribe((motion) => {
        if (motion && !lastMotionState) {
          const now = new Date().toISOString()
          this.cameras = this.cameras.map((c) =>
            c.id === camId ? { ...c, lastMotionAt: now } : c,
          )
          this.callbacks.onCamerasUpdated(this.getCameras())
          this.pushEvent({
            id: crypto.randomUUID(),
            timestamp: now,
            sourceType: 'camera',
            deviceId: camId,
            deviceName: cam.name,
            kind: 'motion',
            title: `Motion Detected — ${cam.name}`,
            detail: 'Camera motion alert received from Ring.',
            severity: 'warning',
          })
          void this.aiPackageService.handleAutoTrigger(camId, 'motion')
          void this.autoCaptureIfEnabled(camId, 'motion')
        }
        lastMotionState = motion
      }),
    )
  }

  async autoCaptureIfEnabled(
    cameraId: string,
    trigger: 'motion' | 'ding' | 'package',
  ): Promise<void> {
    if (this.recordingCameraIds.has(cameraId) || this.isCameraNvrActive(cameraId)) {
      return
    }
    const settings = this.configStore.getPublicSettings()
    if (trigger === 'motion' && !settings.autoRecordOnMotion) return
    if (trigger === 'ding' && !settings.autoRecordOnDoorbell) return
    if (trigger === 'package' && !settings.autoRecordOnPackage) return
    try {
      await this.captureRecording({
        cameraId,
        durationSeconds: settings.defaultCaptureSeconds,
        trigger,
      })
    } catch {
      // Ignore background auto-capture errors (e.g. battery camera busy)
    }
  }

  private bindSensorSubscription(
    dev: RingDeviceInstance,
    locationId: string,
    locationName: string,
  ): void {
    let initialized = false
    let prevFaulted = Boolean((dev.data as unknown as Record<string, unknown>).faulted)

    this.subscriptions.push(
      dev.onData.subscribe(() => {
        const mapped = this.mapLiveSensor(dev, locationId, locationName)
        this.sensors = this.sensors.map((s) => (s.id === mapped.id ? mapped : s))
        this.callbacks.onSensorsUpdated(this.getSensors())

        if (!initialized) {
          initialized = true
          return
        }

        if (mapped.faulted !== prevFaulted) {
          prevFaulted = mapped.faulted
          const kind =
            mapped.category === 'contact'
              ? mapped.faulted
                ? 'contact-open'
                : 'contact-close'
              : mapped.category === 'flood'
                ? 'flood'
                : 'motion'

          this.pushEvent({
            id: crypto.randomUUID(),
            timestamp: mapped.lastUpdatedAt,
            sourceType: 'sensor',
            deviceId: mapped.id,
            deviceName: mapped.name,
            kind,
            title: `${mapped.name}: ${mapped.statusLabel}`,
            detail: `${locationName} · ${mapped.deviceType}`,
            severity: mapped.faulted ? 'warning' : 'info',
          })
        }
      }),
    )
  }

  async refreshDevices(): Promise<{
    locations: RingLocationInfo[]
    cameras: RingCameraInfo[]
    sensors: RingSensorInfo[]
  }> {
    if (this.connection.mode === 'live' && this.ringApi) {
      await this.syncLiveRingAccount(this.ringApi)
    } else {
      this.connection.lastSyncAt = new Date().toISOString()
      this.emitAllState()
    }
    return {
      locations: this.getLocations(),
      cameras: this.getCameras(),
      sensors: this.getSensors(),
    }
  }

  private commitSnapshotBuffer(
    cameraId: string,
    buf: Buffer,
  ): { base64: string; dataUrl: string } {
    const base64 = buf.toString('base64')
    const dataUrl = `data:image/jpeg;base64,${base64}`
    const now = new Date().toISOString()
    this.snapshotCache.set(cameraId, { dataUrl, capturedAt: now })
    this.cameras = this.cameras.map((c) =>
      c.id === cameraId
        ? { ...c, lastSnapshotDataUrl: dataUrl, lastSnapshotAt: now }
        : c,
    )
    this.callbacks.onCamerasUpdated(this.getCameras())
    return { base64, dataUrl }
  }

  private async tryExtractLiveHlsSnapshot(
    cameraId: string,
    waitTimeoutMs = 3500,
  ): Promise<Buffer | null> {
    const segPath = this.streamService.hasActiveFeed(cameraId)
      ? await this.streamService.waitForLatestHlsSegment(cameraId, waitTimeoutMs)
      : this.streamService.getLatestHlsSegmentPath(cameraId)
    if (!segPath) return null
    return this.recordingService.extractJpegFrame(segPath)
  }

  private async tryExtractRecentRecordingSnapshot(
    cameraId: string,
    maxAgeMs = 15 * 60 * 1000,
  ): Promise<Buffer | null> {
    const now = Date.now()
    const recs = this.recordingService
      .listRecordings()
      .filter((r) => r.cameraId === cameraId && fs.existsSync(r.filePath))
    for (const rec of recs.slice(0, 3)) {
      const endMs =
        new Date(rec.createdAt).getTime() + Math.max(0, rec.durationSeconds) * 1000
      if (now - endMs > maxAgeMs) continue
      const frame = await this.recordingService.extractJpegFrame(rec.filePath)
      if (frame) return frame
    }
    return null
  }

  private async tryUnforcedCloudSnapshot(
    liveCam: RingCameraInstance,
  ): Promise<Buffer | null> {
    const camAny = liveCam as unknown as {
      getNextSnapshot?: (opts: {
        force?: boolean
        maxWaitMs?: number
      }) => Promise<Buffer>
    }
    if (typeof camAny.getNextSnapshot !== 'function') return null
    try {
      const buf = await Promise.race([
        camAny.getNextSnapshot({ force: false, maxWaitMs: 4000 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ])
      if (
        buf &&
        Buffer.isBuffer(buf) &&
        buf.length >= 256 &&
        buf[0] === 0xff &&
        buf[1] === 0xd8
      ) {
        return buf
      }
      return null
    } catch {
      return null
    }
  }

  private async tryOneShotLiveFrame(
    cameraId: string,
    liveCam: RingCameraInstance,
  ): Promise<Buffer | null> {
    // Never disrupt an active NVR, Live View, or manual recording stream
    if (
      this.streamService.hasActiveFeed(cameraId) ||
      this.isCameraNvrActive(cameraId) ||
      this.recordingCameraIds.has(cameraId)
    ) {
      return null
    }
    if (typeof liveCam.streamVideo !== 'function') return null

    const tmpDir = path.join(os.tmpdir(), 'ringwatch-snap')
    fs.mkdirSync(tmpDir, { recursive: true })
    const outPath = path.join(
      tmpDir,
      `snap_${cameraId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.jpg`,
    )
    const ffmpegOutPath = outPath.replace(/\\/g, '/')

    let call: { stop(): void; onCallEnded: { subscribe(cb: () => void): unknown } } | null =
      null
    try {
      call = await Promise.race([
        liveCam.streamVideo({
          audio: ['-an'],
          video: ['-vcodec', 'mjpeg', '-q:v', '2'],
          output: ['-frames:v', '1', '-f', 'image2', ffmpegOutPath],
        }),
        new Promise<never>((_res, rej) =>
          setTimeout(() => rej(new Error('One-shot live frame timed out')), 10000),
        ),
      ])

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            call?.stop()
          } catch {
            // ignore
          }
          resolve()
        }, 8000)
        call?.onCallEnded.subscribe(() => {
          clearTimeout(timer)
          resolve()
        })
      })

      if (fs.existsSync(outPath)) {
        const buf = fs.readFileSync(outPath)
        if (buf.length >= 256 && buf[0] === 0xff && buf[1] === 0xd8) {
          return buf
        }
      }
      return null
    } catch {
      try {
        call?.stop()
      } catch {
        // ignore
      }
      return null
    } finally {
      try {
        fs.rmSync(outPath, { force: true })
      } catch {
        // ignore
      }
    }
  }

  private getCachedSnapshotFallback(
    cameraId: string,
  ): { base64: string; dataUrl: string } | null {
    const cachedUrl =
      this.snapshotCache.get(cameraId)?.dataUrl ??
      this.cameras.find((c) => c.id === cameraId)?.lastSnapshotDataUrl
    if (!cachedUrl || !cachedUrl.startsWith('data:image/')) return null
    const commaIdx = cachedUrl.indexOf(',')
    if (commaIdx < 0) return null
    const base64 = cachedUrl.slice(commaIdx + 1)
    if (base64.length < 128) return null
    return { base64, dataUrl: cachedUrl }
  }

  async captureSnapshotBase64(
    cameraId: string,
  ): Promise<{ base64: string; dataUrl: string }> {
    if (this.connection.mode === 'demo') {
      const cam = this.cameras.find((c) => c.id === cameraId)
      if (!cam) throw new Error(`Camera ${cameraId} not found`)
      const imgFile = cam.demoImage || 'front_porch.jpg'
      const fullPath = path.join(this.demoAssetsDir, imgFile)
      const buf = fs.readFileSync(fullPath)
      const base64 = buf.toString('base64')
      const dataUrl = `data:image/jpeg;base64,${base64}`
      const now = new Date().toISOString()
      this.cameras = this.cameras.map((c) =>
        c.id === cameraId
          ? { ...c, lastSnapshotDataUrl: dataUrl, lastSnapshotAt: now }
          : c,
      )
      this.callbacks.onCamerasUpdated(this.getCameras())
      return { base64, dataUrl }
    }

    const liveCam = this.liveCamerasById.get(cameraId)
    if (!liveCam) throw new Error(`Ring camera ${cameraId} is not connected`)

    // Tier 1: Grab an instant live JPEG frame directly from an active NVR / Live View HLS feed.
    // Ring cameras (especially battery/hybrid models like cocoa_camera_v3) refuse cloud snapshot
    // refreshes while a WebRTC live stream is active, causing a 15-second timeout.
    const liveHlsFrame = await this.tryExtractLiveHlsSnapshot(cameraId, 3500)
    if (liveHlsFrame) {
      return this.commitSnapshotBuffer(cameraId, liveHlsFrame)
    }

    // Tier 2: Standard Ring cloud snapshot when no local HLS feed is active yet
    let primaryErr: unknown
    try {
      const buf = await liveCam.getSnapshot()
      if (buf && buf.length >= 256) {
        return this.commitSnapshotBuffer(cameraId, buf)
      }
    } catch (err) {
      primaryErr = err
    }

    // Tier 3a: Re-check active HLS feed (NVR / Live View may have produced segments while waiting)
    const lateHlsFrame = await this.tryExtractLiveHlsSnapshot(cameraId, 1500)
    if (lateHlsFrame) {
      return this.commitSnapshotBuffer(cameraId, lateHlsFrame)
    }

    // Tier 3b: Ask Ring cloud for the latest unforced snapshot (avoids 15s forced-refresh failure)
    const unforcedBuf = await this.tryUnforcedCloudSnapshot(liveCam)
    if (unforcedBuf) {
      return this.commitSnapshotBuffer(cameraId, unforcedBuf)
    }

    // Tier 4: Extract the most recent frame from a recent local MP4 recording (last 15 min)
    const recentClipFrame = await this.tryExtractRecentRecordingSnapshot(cameraId)
    if (recentClipFrame) {
      return this.commitSnapshotBuffer(cameraId, recentClipFrame)
    }

    // Tier 5: Grab a single live frame via a brief one-shot WebRTC stream (when camera is idle)
    const oneShotFrame = await this.tryOneShotLiveFrame(cameraId, liveCam)
    if (oneShotFrame) {
      return this.commitSnapshotBuffer(cameraId, oneShotFrame)
    }

    // Tier 6: Fall back to last cached snapshot so AI scan / UI still has an image
    const cached = this.getCachedSnapshotFallback(cameraId)
    if (cached) {
      return cached
    }

    throw primaryErr instanceof Error
      ? primaryErr
      : new Error(
          `Unable to capture snapshot for camera ${cameraId}: ${String(primaryErr ?? 'no video frame available')}`,
        )
  }

  async captureSnapshot(
    cameraId: string,
  ): Promise<{ dataUrl: string; capturedAt: string }> {
    const { dataUrl } = await this.captureSnapshotBase64(cameraId)
    return { dataUrl, capturedAt: new Date().toISOString() }
  }

  async startLiveStream(cameraId: string): Promise<LiveStreamSession> {
    if (this.connection.mode === 'demo') {
      const session = this.streamService.startDemoStream(cameraId)
      this.callbacks.onCamerasUpdated(this.getCameras())
      return session
    }

    const liveCam = this.liveCamerasById.get(cameraId)
    if (!liveCam) throw new Error(`Ring camera ${cameraId} not found`)

    const session = await this.streamService.startRingHlsStream(
      cameraId,
      liveCam as unknown as StreamableRingCamera,
      () => {
        this.callbacks.onCamerasUpdated(this.getCameras())
      },
    )
    this.callbacks.onCamerasUpdated(this.getCameras())
    return session
  }

  stopLiveStream(cameraId: string): void {
    this.streamService.stopStream(cameraId)
    this.callbacks.onCamerasUpdated(this.getCameras())
  }

  async toggleCameraLight(cameraId: string, on: boolean): Promise<RingCameraInfo> {
    if (this.connection.mode === 'live') {
      const liveCam = this.liveCamerasById.get(cameraId)
      if (!liveCam) throw new Error(`Camera ${cameraId} not found`)
      await liveCam.setLight(on)
    }

    this.cameras = this.cameras.map((c) =>
      c.id === cameraId ? { ...c, lightOn: on } : c,
    )
    const updated = this.getCameras().find((c) => c.id === cameraId)!
    this.callbacks.onCamerasUpdated(this.getCameras())
    this.pushEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sourceType: 'camera',
      deviceId: cameraId,
      deviceName: updated.name,
      kind: 'info',
      title: `${updated.name} Light ${on ? 'On' : 'Off'}`,
      detail: `Floodlight switched ${on ? 'ON' : 'OFF'}.`,
      severity: 'info',
    })
    return updated
  }

  async toggleCameraSiren(cameraId: string, on: boolean): Promise<RingCameraInfo> {
    if (this.connection.mode === 'live') {
      const liveCam = this.liveCamerasById.get(cameraId)
      if (!liveCam) throw new Error(`Camera ${cameraId} not found`)
      await liveCam.setSiren(on)
    }

    this.cameras = this.cameras.map((c) =>
      c.id === cameraId ? { ...c, sirenOn: on } : c,
    )
    const updated = this.getCameras().find((c) => c.id === cameraId)!
    this.callbacks.onCamerasUpdated(this.getCameras())
    this.pushEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sourceType: 'camera',
      deviceId: cameraId,
      deviceName: updated.name,
      kind: 'info',
      title: `${updated.name} Siren ${on ? 'Activated' : 'Silenced'}`,
      detail: `Camera siren ${on ? 'sounded' : 'silenced'} from RingWatch.`,
      severity: on ? 'alert' : 'info',
    })
    return updated
  }

  async setAlarmMode(
    locationId: string,
    mode: 'none' | 'some' | 'all',
  ): Promise<RingLocationInfo> {
    if (this.connection.mode === 'live') {
      const loc = this.liveLocationsById.get(locationId)
      if (!loc) throw new Error(`Location ${locationId} not found`)
      if (mode === 'none') await loc.disarm()
      else if (mode === 'some') await loc.armHome()
      else await loc.armAway()
    }

    this.locations = this.locations.map((l) =>
      l.id === locationId ? { ...l, alarmMode: mode } : l,
    )
    const updated = this.locations.find((l) => l.id === locationId)!
    this.callbacks.onLocationsUpdated(this.getLocations())

    const label =
      mode === 'none' ? 'Disarmed' : mode === 'some' ? 'Home Armed' : 'Away Armed'
    this.pushEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sourceType: 'alarm',
      deviceId: locationId,
      deviceName: updated.name,
      kind: 'alarm-mode',
      title: `Alarm Mode: ${label}`,
      detail: `${updated.name} security mode updated to ${label}.`,
      severity: mode === 'none' ? 'info' : 'success',
    })
    return updated
  }

  async captureRecording(params: {
    cameraId: string
    durationSeconds: number
    trigger?: LocalRecordingItem['trigger']
  }): Promise<LocalRecordingItem> {
    const cam = this.cameras.find((c) => c.id === params.cameraId)
    if (!cam) throw new Error(`Camera ${params.cameraId} not found`)

    const trigger = params.trigger ?? 'manual'
    this.recordingCameraIds.add(params.cameraId)
    this.callbacks.onCamerasUpdated(this.getCameras())

    try {
      let recording: LocalRecordingItem
      if (this.connection.mode === 'demo') {
        const sourceImagePath = path.join(
          this.demoAssetsDir,
          cam.demoImage || 'front_porch.jpg',
        )
        const { dataUrl } = await this.captureSnapshotBase64(params.cameraId)
        recording = await this.recordingService.captureDemoRecording({
          cameraId: cam.id,
          cameraName: cam.name,
          durationSeconds: params.durationSeconds,
          trigger,
          sourceImagePath,
          thumbnailDataUrl: dataUrl,
        })
      } else {
        const liveCam = this.liveCamerasById.get(params.cameraId)
        if (!liveCam) throw new Error(`Ring camera ${params.cameraId} not found`)
        recording = await this.recordingService.captureFromRingCamera({
          cameraId: cam.id,
          cameraName: cam.name,
          camera: liveCam as unknown as RecordableRingCamera,
          durationSeconds: params.durationSeconds,
          trigger,
        })
      }

      this.callbacks.onRecordingsUpdated(this.recordingService.listRecordings())
      this.callbacks.onStorageStatsUpdated(this.recordingService.getStorageStats())
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: recording.createdAt,
        sourceType: 'recording',
        deviceId: cam.id,
        deviceName: cam.name,
        kind: 'recording-saved',
        title: `Recording Captured — ${cam.name}`,
        detail: `Saved ${recording.fileName} (${recording.durationSeconds}s).`,
        severity: 'success',
        snapshotDataUrl: recording.thumbnailDataUrl,
      })

      return recording
    } finally {
      this.recordingCameraIds.delete(params.cameraId)
      this.callbacks.onCamerasUpdated(this.getCameras())
    }
  }

  async listCloudRecordings(cameraId: string): Promise<CloudRecordingItem[]> {
    const cam = this.cameras.find((c) => c.id === cameraId)
    if (!cam) return []

    if (this.connection.mode === 'demo') {
      const now = Date.now()
      return [
        {
          id: `${cameraId}-cloud-1`,
          cameraId,
          cameraName: cam.name,
          kind: cam.isDoorbell ? 'ding' : 'motion',
          createdAt: new Date(now - 14 * 60 * 1000).toISOString(),
          durationSeconds: 32,
          favorite: false,
          cvPackageDetected: cameraId === 'demo-cam-front',
        },
        {
          id: `${cameraId}-cloud-2`,
          cameraId,
          cameraName: cam.name,
          kind: 'motion',
          createdAt: new Date(now - 95 * 60 * 1000).toISOString(),
          durationSeconds: 24,
          favorite: true,
          cvPackageDetected: false,
        },
        {
          id: `${cameraId}-cloud-3`,
          cameraId,
          cameraName: cam.name,
          kind: 'on_demand',
          createdAt: new Date(now - 240 * 60 * 1000).toISOString(),
          durationSeconds: 45,
          favorite: false,
          cvPackageDetected: false,
        },
      ]
    }

    const liveCam = this.liveCamerasById.get(cameraId)
    if (!liveCam) return []

    const res = await liveCam.getEvents({ limit: 25 })
    const rawEvents = (res.events ?? []) as unknown as Array<Record<string, unknown>>

    return rawEvents.map((ev) => ({
      id: String(ev.ding_id_str ?? ev.ding_id ?? crypto.randomUUID()),
      cameraId,
      cameraName: cam.name,
      kind: String(ev.kind ?? 'motion'),
      createdAt: String(ev.created_at ?? new Date().toISOString()),
      durationSeconds: Number(ev.duration ?? 30),
      favorite: Boolean(ev.favorite),
      cvPackageDetected: Boolean(
        (ev.cv_properties as Record<string, unknown> | undefined)?.detection_type ===
          'package',
      ),
    }))
  }

  async downloadCloudRecording(
    cameraId: string,
    dingId: string,
  ): Promise<LocalRecordingItem> {
    const cam = this.cameras.find((c) => c.id === cameraId)
    if (!cam) throw new Error(`Camera ${cameraId} not found`)

    if (this.connection.mode === 'demo') {
      return this.captureRecording({
        cameraId,
        durationSeconds: 15,
        trigger: 'cloud-download',
      })
    }

    const liveCam = this.liveCamerasById.get(cameraId)
    if (!liveCam) throw new Error(`Ring camera ${cameraId} not found`)

    const item = await this.recordingService.downloadCloudRecording({
      cameraId,
      cameraName: cam.name,
      camera: liveCam as unknown as RecordableRingCamera,
      dingId,
      durationSeconds: 30,
      thumbnailDataUrl: cam.lastSnapshotDataUrl,
    })

    this.callbacks.onRecordingsUpdated(this.recordingService.listRecordings())
    this.pushEvent({
      id: crypto.randomUUID(),
      timestamp: item.createdAt,
      sourceType: 'recording',
      deviceId: cam.id,
      deviceName: cam.name,
      kind: 'recording-saved',
      title: `Cloud Clip Downloaded — ${cam.name}`,
      detail: `Saved ${item.fileName} to local vault.`,
      severity: 'success',
    })
    return item
  }

  async simulateDemoEvent(
    kind: 'doorbell' | 'motion' | 'contact-open' | 'package-delivery',
  ): Promise<void> {
    if (this.connection.mode !== 'demo') return
    const now = new Date().toISOString()

    if (kind === 'contact-open') {
      const target = this.sensors.find((s) => s.id === 'demo-sensor-front-door')
      if (!target) return
      const nextFaulted = !target.faulted
      this.sensors = this.sensors.map((s) =>
        s.id === target.id
          ? {
              ...s,
              faulted: nextFaulted,
              statusLabel: nextFaulted ? 'Open' : 'Closed',
              lastUpdatedAt: now,
            }
          : s,
      )
      this.callbacks.onSensorsUpdated(this.getSensors())
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: now,
        sourceType: 'sensor',
        deviceId: target.id,
        deviceName: target.name,
        kind: nextFaulted ? 'contact-open' : 'contact-close',
        title: `${target.name} ${nextFaulted ? 'Opened' : 'Closed'}`,
        detail: `Maple Street Home · Contact sensor changed to ${nextFaulted ? 'Open' : 'Closed'}.`,
        severity: nextFaulted ? 'warning' : 'info',
      })
      return
    }

    if (kind === 'motion') {
      const cam = this.cameras.find((c) => c.id === 'demo-cam-driveway') ?? this.cameras[0]
      if (!cam) return
      this.cameras = this.cameras.map((c) =>
        c.id === cam.id ? { ...c, lastMotionAt: now } : c,
      )
      this.callbacks.onCamerasUpdated(this.getCameras())
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: now,
        sourceType: 'camera',
        deviceId: cam.id,
        deviceName: cam.name,
        kind: 'motion',
        title: `Motion Detected — ${cam.name}`,
        detail: 'Simulated vehicle & movement event in driveway zone.',
        severity: 'warning',
        snapshotDataUrl: cam.lastSnapshotDataUrl,
      })
      await this.aiPackageService.handleAutoTrigger(cam.id, 'motion')
      return
    }

    if (kind === 'doorbell') {
      const cam = this.cameras.find((c) => c.id === 'demo-cam-front') ?? this.cameras[0]
      if (!cam) return
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: now,
        sourceType: 'camera',
        deviceId: cam.id,
        deviceName: cam.name,
        kind: 'ding',
        title: `Doorbell Ring — ${cam.name}`,
        detail: 'Simulated visitor pressed Front Porch Doorbell Pro.',
        severity: 'alert',
        snapshotDataUrl: cam.lastSnapshotDataUrl,
      })
      await this.aiPackageService.handleAutoTrigger(cam.id, 'doorbell')
      return
    }

    if (kind === 'package-delivery') {
      const cam = this.cameras.find((c) => c.id === 'demo-cam-front') ?? this.cameras[0]
      if (!cam) return
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: now,
        sourceType: 'camera',
        deviceId: cam.id,
        deviceName: cam.name,
        kind: 'motion',
        title: `Delivery Activity — ${cam.name}`,
        detail: 'Motion detected on front porch — triggering AI Package Vision scan.',
        severity: 'warning',
        snapshotDataUrl: cam.lastSnapshotDataUrl,
      })
      await this.aiPackageService.scanCamera(cam.id, 'manual')
    }
  }

  private cancellableDelay(worker: NvrWorker, ms: number): Promise<boolean> {
    if (worker.stopped || ms <= 0) return Promise.resolve(!worker.stopped)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.cancelWait = undefined
        resolve(!worker.stopped)
      }, ms)
      worker.cancelWait = () => {
        clearTimeout(timer)
        worker.cancelWait = undefined
        resolve(false)
      }
    })
  }

  private resolveTargetNvrCameras(explicitCameraIds?: string[]): RingCameraInfo[] {
    if (explicitCameraIds && explicitCameraIds.length > 0) {
      const set = new Set(explicitCameraIds)
      return this.cameras.filter((c) => set.has(c.id))
    }
    const settings = this.configStore.getPublicSettings()
    if (settings.continuousCameraIds.length > 0) {
      const set = new Set(settings.continuousCameraIds)
      return this.cameras.filter((c) => set.has(c.id))
    }
    if (settings.continuousSkipBatteryCams) {
      return this.cameras.filter((c) => c.batteryPercent === null)
    }
    return [...this.cameras]
  }

  async startAllCameraRecording(cameraIds?: string[]): Promise<NvrStatus> {
    const targets = this.resolveTargetNvrCameras(cameraIds)
    if (targets.length === 0) {
      throw new Error(
        'No eligible cameras found to record. Check your camera list or Continuous Recording settings.',
      )
    }

    if (!this.nvrStartedAt) {
      this.nvrStartedAt = new Date().toISOString()
    }

    let staggerIndex = 0
    for (const cam of targets) {
      const existing = this.nvrWorkers.get(cam.id)
      if (existing && !existing.stopped) continue

      const staggerMs =
        this.connection.mode === 'live' ? staggerIndex * 600 : staggerIndex * 150
      staggerIndex++

      const worker: NvrWorker = {
        cameraId: cam.id,
        cameraName: cam.name,
        stopped: false,
        state: 'connecting',
        startedAt: new Date().toISOString(),
        lastActivityMs: Date.now(),
        segmentsCaptured: 0,
        reconnectCount: 0,
        bytesRecorded: 0,
        consecutiveFailures: 0,
        offlineNotified: false,
      }
      this.nvrWorkers.set(cam.id, worker)

      worker.promise =
        this.connection.mode === 'live'
          ? this.runLiveNvrWorker(worker, staggerMs)
          : this.runDemoNvrWorker(worker, staggerMs)
    }

    this.emitNvrStatus()
    this.pushEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sourceType: 'recording',
      deviceName: 'RingWatch NVR',
      kind: 'info',
      title: `24/7 NVR Recording Started (${targets.length} camera${targets.length === 1 ? '' : 's'})`,
      detail: `Recording rolling ${this.configStore.getPublicSettings().continuousSegmentSeconds}s local MP4 segments for the Timeline.`,
      severity: 'success',
    })

    return this.getNvrStatus()
  }

  async stopAllCameraRecording(): Promise<NvrStatus> {
    const activeWorkers = Array.from(this.nvrWorkers.values())
    if (activeWorkers.length === 0) {
      this.nvrStartedAt = undefined
      this.emitNvrStatus()
      return this.getNvrStatus()
    }

    for (const worker of activeWorkers) {
      worker.stopped = true
      worker.state = 'stopped'
      worker.cancelWait?.()
      try {
        worker.activeCall?.stop()
      } catch {
        // ignore
      }
    }

    const pending = activeWorkers
      .map((w) => w.promise)
      .filter((p): p is Promise<void> => Boolean(p))
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((r) => setTimeout(r, 3500)),
      ])
    }

    this.nvrWorkers.clear()
    this.nvrStartedAt = undefined
    this.emitNvrStatus()
    this.callbacks.onRecordingsUpdated(this.recordingService.listRecordings())
    this.callbacks.onStorageStatsUpdated(this.recordingService.getStorageStats())

    this.pushEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sourceType: 'recording',
      deviceName: 'RingWatch NVR',
      kind: 'info',
      title: 'Continuous Recording Stopped',
      detail: 'Finalized all active camera segments and saved to local vault.',
      severity: 'info',
    })

    return this.getNvrStatus()
  }

  async toggleCameraContinuousRecording(
    cameraId: string,
    enable: boolean,
  ): Promise<NvrStatus> {
    const cam = this.cameras.find((c) => c.id === cameraId)
    if (!cam) throw new Error(`Camera ${cameraId} not found`)

    if (enable) {
      return this.startAllCameraRecording([cameraId])
    }

    const worker = this.nvrWorkers.get(cameraId)
    if (worker) {
      worker.stopped = true
      worker.state = 'stopped'
      worker.cancelWait?.()
      try {
        worker.activeCall?.stop()
      } catch {
        // ignore
      }
      if (worker.promise) {
        await Promise.race([
          worker.promise.catch(() => {}),
          new Promise((r) => setTimeout(r, 2500)),
        ])
      }
      this.nvrWorkers.delete(cameraId)
    }

    if (this.nvrWorkers.size === 0) {
      this.nvrStartedAt = undefined
    }
    this.emitNvrStatus()
    this.callbacks.onRecordingsUpdated(this.recordingService.listRecordings())
    this.callbacks.onStorageStatsUpdated(this.recordingService.getStorageStats())
    return this.getNvrStatus()
  }

  private recordWorkerSegmentMetrics(
    worker: NvrWorker,
    saved: LocalRecordingItem,
    nextSegStartIso?: string,
  ): void {
    const nowIso = new Date().toISOString()
    worker.segmentsCaptured++
    this.nvrTotalSegmentsCaptured++
    worker.bytesRecorded += saved.sizeBytes
    worker.lastSegmentAt = nowIso
    worker.lastActivityMs = Date.now()
    worker.consecutiveFailures = 0
    if (saved.durationSeconds > 0) {
      worker.estimatedBitrateKbps = Math.max(
        1,
        Math.round((saved.sizeBytes * 8) / saved.durationSeconds / 1000),
      )
    }
    if (nextSegStartIso) {
      worker.currentSegmentStartedAt = nextSegStartIso
    }

    if (worker.offlineNotified) {
      worker.offlineNotified = false
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: nowIso,
        sourceType: 'camera',
        deviceId: worker.cameraId,
        deviceName: worker.cameraName,
        kind: 'nvr-health',
        title: `Camera Stream Recovered — ${worker.cameraName}`,
        detail: '24/7 NVR recording resumed normally and is writing segments to storage.',
        severity: 'success',
      })
    }
  }

  private handleWorkerFailureNotification(worker: NvrWorker, reason: string): void {
    worker.consecutiveFailures++
    if (worker.consecutiveFailures >= 3 && !worker.offlineNotified) {
      worker.offlineNotified = true
      const settings = this.configStore.getPublicSettings()
      this.pushEvent({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sourceType: 'camera',
        deviceId: worker.cameraId,
        deviceName: worker.cameraName,
        kind: 'nvr-health',
        title: `Camera Recording Interrupted — ${worker.cameraName}`,
        detail: `${reason}. RingWatch NVR will keep retrying automatically.`,
        severity: 'alert',
      })
      this.notifications?.notifyNvrAlert({
        title: `RingWatch NVR — ${worker.cameraName} Offline`,
        body: `24/7 stream interrupted (${reason}). Retrying automatically in background.`,
        severity: 'warning',
        desktopEnabled: settings.nvrNotificationsEnabled,
      })
    }
  }

  private async runLiveNvrWorker(worker: NvrWorker, initialDelayMs: number): Promise<void> {
    if (initialDelayMs > 0) {
      const ok = await this.cancellableDelay(worker, initialDelayMs)
      if (!ok) return
    }

    while (!worker.stopped) {
      const liveCam = this.liveCamerasById.get(worker.cameraId)
      const camInfo = this.cameras.find((c) => c.id === worker.cameraId)
      if (!liveCam || !camInfo) {
        worker.state = 'error'
        worker.lastError = 'Camera disconnected from Ring'
        this.emitNvrStatus()
        break
      }

      const segmentSeconds = this.configStore.getPublicSettings().continuousSegmentSeconds
      const sessionDate = new Date()
      const target = this.recordingService.createNvrSegmentTarget(
        camInfo.name,
        sessionDate,
      )
      const hlsOutput = await this.streamService.prepareNvrHlsOutput(worker.cameraId)
      const indexedFiles = new Set<string>()
      let lastIndexedEndSec = 0
      let sessionStartMs = Date.now()
      let pollTimer: NodeJS.Timeout | null = null

      const syncCompletedSegments = () => {
        if (!fs.existsSync(target.segmentListPath)) return
        let raw = ''
        try {
          raw = fs.readFileSync(target.segmentListPath, 'utf-8')
        } catch {
          return
        }
        const lines = raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)

        let addedAny = false
        for (const line of lines) {
          const parts = line.split(',')
          if (parts.length < 3) continue
          const rawFile = parts[0].trim()
          const startSec = Number.parseFloat(parts[1])
          const endSec = Number.parseFloat(parts[2])
          if (!rawFile || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
            continue
          }
          const fullPath = path.isAbsolute(rawFile)
            ? rawFile
            : path.join(target.dir, path.basename(rawFile))
          const key = path.resolve(fullPath).toLowerCase()
          if (indexedFiles.has(key)) continue

          const createdAt = new Date(
            sessionStartMs + Math.max(0, startSec) * 1000,
          ).toISOString()
          const duration = Math.max(1, Math.round(endSec - startSec))
          const thumb =
            this.snapshotCache.get(worker.cameraId)?.dataUrl ??
            camInfo.lastSnapshotDataUrl

          const saved = this.recordingService.registerRecordedSegment({
            cameraId: worker.cameraId,
            cameraName: camInfo.name,
            filePath: fullPath,
            createdAt,
            durationSeconds: duration,
            trigger: 'continuous',
            thumbnailDataUrl: thumb,
          })

          indexedFiles.add(key)
          if (endSec > lastIndexedEndSec) {
            lastIndexedEndSec = endSec
          }

          if (saved) {
            addedAny = true
            this.recordWorkerSegmentMetrics(
              worker,
              saved,
              new Date(sessionStartMs + Math.max(0, endSec) * 1000).toISOString(),
            )
          }
        }

        if (addedAny) {
          this.callbacks.onRecordingsUpdated(this.recordingService.listRecordings())
          this.callbacks.onStorageStatsUpdated(this.recordingService.getStorageStats())
          this.emitNvrStatus()
        }
      }

      const flushTrailingPartialSegment = () => {
        try {
          const entries = fs.readdirSync(target.dir)
          const matching = entries
            .filter(
              (name) =>
                name.startsWith(`${target.prefix}_`) &&
                name.toLowerCase().endsWith('.mp4'),
            )
            .sort()

          let addedAny = false
          for (const name of matching) {
            const fullPath = path.join(target.dir, name)
            const key = path.resolve(fullPath).toLowerCase()
            if (indexedFiles.has(key)) continue
            const stat = fs.statSync(fullPath)
            if (stat.size < 4096) continue

            const estStartMs = sessionStartMs + Math.max(0, lastIndexedEndSec) * 1000
            const estDur = Math.max(
              2,
              Math.min(segmentSeconds, Math.round((Date.now() - estStartMs) / 1000)),
            )
            const thumb =
              this.snapshotCache.get(worker.cameraId)?.dataUrl ??
              camInfo.lastSnapshotDataUrl

            const saved = this.recordingService.registerRecordedSegment({
              cameraId: worker.cameraId,
              cameraName: camInfo.name,
              filePath: fullPath,
              createdAt: new Date(estStartMs).toISOString(),
              durationSeconds: estDur,
              trigger: 'continuous',
              thumbnailDataUrl: thumb,
            })
            indexedFiles.add(key)
            if (saved) {
              addedAny = true
              this.recordWorkerSegmentMetrics(worker, saved)
            }
          }

          if (addedAny) {
            this.callbacks.onRecordingsUpdated(this.recordingService.listRecordings())
            this.callbacks.onStorageStatsUpdated(this.recordingService.getStorageStats())
          }
        } catch {
          // Ignore directory scan failures during shutdown
        }
      }

      try {
        worker.state = worker.consecutiveFailures > 0 ? 'reconnecting' : 'connecting'
        this.emitNvrStatus()

        const call = await liveCam.streamVideo({
          video: ['-vcodec', 'copy'],
          audio: ['-acodec', 'aac', '-b:a', '96k'],
          output: [
            // Output 0: Rolling fragmented MP4 segments for Timeline & Local Vault
            '-f',
            'segment',
            '-segment_time',
            String(segmentSeconds),
            '-reset_timestamps',
            '1',
            '-segment_format',
            'mp4',
            '-segment_format_options',
            'movflags=+frag_keyframe+empty_moov+default_base_moof',
            '-segment_list',
            target.ffmpegSegmentListPath,
            '-segment_list_type',
            'csv',
            target.ffmpegSegmentPattern,
            // Output 1: Live HLS playlist sharing the SAME Ring WebRTC stream
            '-vcodec',
            'copy',
            '-acodec',
            'aac',
            '-b:a',
            '96k',
            '-f',
            'hls',
            '-hls_time',
            '1',
            '-hls_list_size',
            '8',
            '-hls_delete_threshold',
            '4',
            '-hls_flags',
            'delete_segments+independent_segments+temp_file',
            '-hls_segment_filename',
            hlsOutput.ffmpegSegmentPattern,
            hlsOutput.ffmpegPlaylistPath,
          ],
        })

        sessionStartMs = Date.now()
        worker.activeCall = call
        worker.state = 'recording'
        worker.lastError = undefined
        worker.lastActivityMs = sessionStartMs
        worker.currentSegmentStartedAt = new Date(sessionStartMs).toISOString()
        this.streamService.registerNvrHlsFeed(worker.cameraId, hlsOutput)
        this.emitNvrStatus()

        const cachedSnap = this.snapshotCache.get(worker.cameraId)
        const snapAgeMs = cachedSnap
          ? Date.now() - new Date(cachedSnap.capturedAt).getTime()
          : Number.POSITIVE_INFINITY
        if (!cachedSnap || snapAgeMs > 5 * 60 * 1000) {
          void this.tryExtractLiveHlsSnapshot(worker.cameraId, 8000)
            .then((frame) => {
              if (frame && !worker.stopped) {
                this.commitSnapshotBuffer(worker.cameraId, frame)
              }
            })
            .catch(() => {})
        }

        if (worker.stopped) {
          try {
            call.stop()
          } catch {
            // ignore
          }
        }

        pollTimer = setInterval(syncCompletedSegments, 2500)

        await new Promise<void>((resolve) => {
          call.onCallEnded.subscribe(() => resolve())
        })

        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }

        // Brief settle window for Windows file handles before flushing final segments
        await new Promise((r) => setTimeout(r, 450))
        syncCompletedSegments()
        flushTrailingPartialSegment()

        worker.activeCall = undefined
        this.streamService.unregisterNvrHlsFeed(worker.cameraId)
        try {
          fs.rmSync(target.segmentListPath, { force: true })
        } catch {
          // ignore
        }

        if (worker.stopped) break

        // Normal Ring ~10-minute WebRTC session rotation -> quick seamless reconnect
        const ranMs = Date.now() - sessionStartMs
        worker.reconnectCount++
        if (ranMs >= 25000) {
          worker.consecutiveFailures = 0
          worker.state = 'reconnecting'
          this.emitNvrStatus()
          const keepGoing = await this.cancellableDelay(worker, 1000)
          if (!keepGoing) break
        } else {
          const reason = `Stream closed after ${Math.round(ranMs / 1000)}s`
          this.handleWorkerFailureNotification(worker, reason)
          const backoffMs = Math.min(60000, 5000 * 2 ** (worker.consecutiveFailures - 1))
          worker.state = 'reconnecting'
          worker.lastError = `${reason}; retrying in ${Math.round(backoffMs / 1000)}s`
          this.emitNvrStatus()
          const keepGoing = await this.cancellableDelay(worker, backoffMs)
          if (!keepGoing) break
        }
      } catch (err) {
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        worker.activeCall = undefined
        this.streamService.clearPendingNvrCamera(worker.cameraId)
        this.streamService.unregisterNvrHlsFeed(worker.cameraId)
        try {
          fs.rmSync(target.segmentListPath, { force: true })
        } catch {
          // ignore
        }

        if (worker.stopped) break

        worker.reconnectCount++
        const message = err instanceof Error ? err.message : String(err)
        this.handleWorkerFailureNotification(worker, message)
        const backoffMs = Math.min(60000, 5000 * 2 ** (worker.consecutiveFailures - 1))
        worker.state = 'reconnecting'
        worker.lastError = `${message} (retrying in ${Math.round(backoffMs / 1000)}s)`
        this.emitNvrStatus()

        const keepGoing = await this.cancellableDelay(worker, backoffMs)
        if (!keepGoing) break
      }
    }

    this.streamService.clearPendingNvrCamera(worker.cameraId)
    worker.state = 'stopped'
    worker.currentSegmentStartedAt = undefined
    this.emitNvrStatus()
  }

  private async runDemoNvrWorker(worker: NvrWorker, initialDelayMs: number): Promise<void> {
    if (initialDelayMs > 0) {
      const ok = await this.cancellableDelay(worker, initialDelayMs)
      if (!ok) return
    }

    const demoCadenceSeconds = Math.min(
      this.configStore.getPublicSettings().continuousSegmentSeconds,
      20,
    )

    while (!worker.stopped) {
      const cam = this.cameras.find((c) => c.id === worker.cameraId)
      if (!cam) break

      const segStart = new Date()
      worker.state = 'recording'
      worker.currentSegmentStartedAt = segStart.toISOString()
      worker.lastError = undefined
      this.emitNvrStatus()

      const waitMs = worker.segmentsCaptured === 0 ? 3000 : demoCadenceSeconds * 1000
      const ok = await this.cancellableDelay(worker, waitMs)
      if (!ok) break

      try {
        const sourceImagePath = path.join(
          this.demoAssetsDir,
          cam.demoImage || 'front_porch.jpg',
        )
        const { dataUrl } = await this.captureSnapshotBase64(cam.id)
        const saved = await this.recordingService.captureDemoRecording({
          cameraId: cam.id,
          cameraName: cam.name,
          durationSeconds: Math.max(6, Math.round(waitMs / 1000)),
          trigger: 'continuous',
          sourceImagePath,
          thumbnailDataUrl: dataUrl,
          createdAtOverride: segStart.toISOString(),
        })
        this.recordWorkerSegmentMetrics(worker, saved)
        this.callbacks.onRecordingsUpdated(this.recordingService.listRecordings())
        this.callbacks.onStorageStatsUpdated(this.recordingService.getStorageStats())
        this.emitNvrStatus()
      } catch (err) {
        worker.lastError = err instanceof Error ? err.message : String(err)
        this.emitNvrStatus()
        const retry = await this.cancellableDelay(worker, 8000)
        if (!retry) break
      }
    }

    worker.state = 'stopped'
    worker.currentSegmentStartedAt = undefined
    this.emitNvrStatus()
  }

  async syncCloudEventsToTimeline(): Promise<{
    addedCount: number
    events: SecurityEvent[]
  }> {
    let addedCount = 0
    const existingIds = new Set(this.events.map((e) => e.id))

    if (this.connection.mode === 'demo') {
      const recs = this.recordingService.listRecordings()
      for (const rec of recs) {
        const id = `demo-sync-${rec.id}`
        if (existingIds.has(id)) continue
        const kind: SecurityEvent['kind'] =
          rec.trigger === 'ding'
            ? 'ding'
            : rec.trigger === 'package'
              ? 'package-detected'
              : 'motion'
        this.events.push({
          id,
          timestamp: rec.createdAt,
          sourceType: rec.trigger === 'package' ? 'ai-package' : 'camera',
          deviceId: rec.cameraId,
          deviceName: rec.cameraName,
          kind,
          title:
            kind === 'ding'
              ? `Doorbell Pressed — ${rec.cameraName}`
              : kind === 'package-detected'
                ? `Package Detected — ${rec.cameraName}`
                : `Motion Detected — ${rec.cameraName}`,
          detail: `Synced timeline event aligned with ${rec.fileName}.`,
          severity: kind === 'ding' ? 'alert' : 'warning',
        })
        existingIds.add(id)
        addedCount++
      }
    } else {
      const results = await Promise.allSettled(
        this.cameras.map(async (cam) => {
          const liveCam = this.liveCamerasById.get(cam.id)
          if (!liveCam) return [] as SecurityEvent[]
          const res = await liveCam.getEvents({ limit: 35 })
          const rawEvents = (res.events ?? []) as unknown as Array<
            Record<string, unknown>
          >
          return rawEvents.map((ev): SecurityEvent => {
            const dingId = String(ev.ding_id_str ?? ev.ding_id ?? crypto.randomUUID())
            const rawKind = String(ev.kind ?? 'motion').toLowerCase()
            const cvType = String(
              (ev.cv_properties as Record<string, unknown> | undefined)
                ?.detection_type ?? '',
            ).toLowerCase()

            const kind: SecurityEvent['kind'] =
              cvType === 'package'
                ? 'package-detected'
                : rawKind === 'ding'
                  ? 'ding'
                  : 'motion'

            return {
              id: `ring-cloud-${cam.id}-${dingId}`,
              timestamp: String(ev.created_at ?? new Date().toISOString()),
              sourceType: kind === 'package-detected' ? 'ai-package' : 'camera',
              deviceId: cam.id,
              deviceName: cam.name,
              kind,
              title:
                kind === 'ding'
                  ? `Doorbell Pressed — ${cam.name}`
                  : kind === 'package-detected'
                    ? `Package Activity — ${cam.name}`
                    : `Motion Detected — ${cam.name}`,
              detail: `Ring Cloud ${rawKind} event (${Number(ev.duration ?? 30)}s).`,
              severity: kind === 'ding' ? 'alert' : 'warning',
            }
          })
        }),
      )

      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        for (const ev of r.value) {
          if (existingIds.has(ev.id)) continue
          this.events.push(ev)
          existingIds.add(ev.id)
          addedCount++
        }
      }
    }

    if (addedCount > 0) {
      this.events.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      this.events = this.events.slice(0, 500)
      this.saveEventsToDisk()
      this.callbacks.onEventsUpdated?.(this.getEvents())
    }

    return { addedCount, events: this.getEvents() }
  }

  private emitAllState(): void {
    this.callbacks.onConnectionChanged(this.getConnection())
    this.callbacks.onSettingsUpdated?.(this.configStore.getPublicSettings())
    this.callbacks.onLocationsUpdated(this.getLocations())
    this.callbacks.onCamerasUpdated(this.getCameras())
    this.callbacks.onSensorsUpdated(this.getSensors())
    this.callbacks.onNvrStatusUpdated?.(this.getNvrStatus())
    this.callbacks.onEventsUpdated?.(this.getEvents())
  }

  shutdown(): void {
    this.stopNvrWatchdog()
    this.aiPackageService.stop()
    this.clearLiveSubscriptions()
    this.syncPowerSaveBlocker()
  }
}
