import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Subscription } from 'rxjs'
import type {
  AlarmMode,
  AppMode,
  CloudRecordingItem,
  ConnectionStatus,
  LiveStreamSession,
  LocalRecordingItem,
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

type RingClientApiModule = typeof import('ring-client-api')
type RingRestClientModule = typeof import('ring-client-api/lib/rest-client')
type RingApiInstance = InstanceType<RingClientApiModule['RingApi']>
type RingRestClientInstance = InstanceType<RingRestClientModule['RingRestClient']>
type RingCameraInstance = Awaited<ReturnType<RingApiInstance['getCameras']>>[number]
type RingLocationInstance = Awaited<ReturnType<RingApiInstance['getLocations']>>[number]
type RingDeviceInstance = Awaited<ReturnType<RingLocationInstance['getDevices']>>[number]

// Load ESM-only ring-client-api cleanly from CommonJS Electron main
const importRingClientApi = (): Promise<RingClientApiModule> =>
  (Function('return import("ring-client-api")')() as Promise<RingClientApiModule>)

const importRingRestClient = (): Promise<RingRestClientModule> =>
  (Function(
    'return import("ring-client-api/rest-client")',
  )() as Promise<RingRestClientModule>)

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
  onCamerasUpdated: (cameras: RingCameraInfo[]) => void
  onSensorsUpdated: (sensors: RingSensorInfo[]) => void
  onLocationsUpdated: (locations: RingLocationInfo[]) => void
  onSecurityEvent: (event: SecurityEvent) => void
  onRecordingsUpdated: (recordings: LocalRecordingItem[]) => void
  onStorageStatsUpdated: (stats: import('../../shared/types').StorageStats) => void
}

export class RingService implements SnapshotSource {
  private readonly configStore: ConfigStore
  private readonly streamService: StreamService
  private readonly recordingService: RecordingService
  private readonly aiPackageService: AiPackageService
  private readonly callbacks: RingServiceCallbacks
  private readonly demoAssetsDir: string

  private ringApi: RingApiInstance | null = null
  private pendingAuthClient: RingRestClientInstance | null = null
  private subscriptions: Subscription[] = []
  private liveCamerasById = new Map<string, RingCameraInstance>()
  private liveLocationsById = new Map<string, RingLocationInstance>()
  private recordingCameraIds = new Set<string>()
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
    configStore: ConfigStore
    streamService: StreamService
    recordingService: RecordingService
    aiPackageService: AiPackageService
    demoAssetsDir: string
    callbacks: RingServiceCallbacks
  }) {
    this.configStore = params.configStore
    this.streamService = params.streamService
    this.recordingService = params.recordingService
    this.aiPackageService = params.aiPackageService
    this.demoAssetsDir = params.demoAssetsDir
    this.callbacks = params.callbacks
  }

  async initialize(): Promise<void> {
    await this.streamService.startServer()
    this.aiPackageService.attachSnapshotSource(this)

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

  getCameras(): RingCameraInfo[] {
    return this.cameras.map((cam) => ({
      ...cam,
      isStreaming: this.streamService.isStreaming(cam.id),
      isRecording: this.recordingCameraIds.has(cam.id),
    }))
  }

  getSensors(): RingSensorInfo[] {
    return [...this.sensors]
  }

  getEvents(): SecurityEvent[] {
    return [...this.events]
  }

  getCameraMeta(cameraId: string): { id: string; name: string } | undefined {
    const cam = this.cameras.find((c) => c.id === cameraId)
    return cam ? { id: cam.id, name: cam.name } : undefined
  }

  listCameraIds(): string[] {
    return this.cameras.map((c) => c.id)
  }

  private pushEvent(event: SecurityEvent): void {
    this.events.unshift(event)
    this.events = this.events.slice(0, 200)
    this.callbacks.onSecurityEvent(event)
  }

  private clearLiveSubscriptions(): void {
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

    return this.getConnection()
  }

  async switchMode(mode: AppMode): Promise<ConnectionStatus> {
    if (mode === 'demo') {
      return this.activateDemoMode()
    }
    const token = this.configStore.getRingRefreshToken()
    if (!token) {
      this.connection = {
        connected: false,
        mode: 'live',
        locationCount: 0,
        cameraCount: 0,
        sensorCount: 0,
        error: 'Sign in with your Ring account or paste a Ring refresh token in Settings.',
      }
      this.configStore.updateSettings({ mode: 'live' })
      this.callbacks.onConnectionChanged(this.getConnection())
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

    try {
      const { RingApi } = await importRingClientApi()
      const settings = this.configStore.getPublicSettings()
      const api = new RingApi({
        refreshToken: trimmed,
        controlCenterDisplayName: 'RingWatch Windows',
        cameraStatusPollingSeconds: 20,
        locationModePollingSeconds: 30,
        ffmpegPath: settings.ffmpegPath || undefined,
      })

      this.ringApi = api
      this.configStore.setRingRefreshToken(trimmed)
      this.configStore.updateSettings({ mode: 'live' })

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
      this.connection = {
        connected: false,
        mode: 'live',
        locationCount: 0,
        cameraCount: 0,
        sensorCount: 0,
        error: message,
      }
      this.callbacks.onConnectionChanged(this.getConnection())
      return this.getConnection()
    }
  }

  async disconnectRing(): Promise<ConnectionStatus> {
    this.configStore.setRingRefreshToken(null)
    return this.activateDemoMode()
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

    const nextLocations: RingLocationInfo[] = []
    const nextCameras: RingCameraInfo[] = []
    const nextSensors: RingSensorInfo[] = []

    for (const loc of rawLocations) {
      this.liveLocationsById.set(loc.id, loc)

      let alarmMode: AlarmMode = 'unknown'
      if (loc.hasAlarmBaseStation) {
        try {
          alarmMode = (await loc.getAlarmMode()) as AlarmMode
        } catch {
          alarmMode = 'unknown'
        }
      }

      nextLocations.push({
        id: loc.id,
        name: loc.name,
        hasAlarm: loc.hasAlarmBaseStation,
        alarmMode,
      })

      for (const cam of loc.cameras) {
        const camId = String(cam.id)
        this.liveCamerasById.set(camId, cam)
        nextCameras.push(this.mapLiveCamera(cam, loc.id, loc.name))
        this.bindCameraSubscriptions(cam, loc.id, loc.name)
      }

      if (loc.hasHubs || loc.hasAlarmBaseStation) {
        try {
          const devices = await loc.getDevices()
          for (const dev of devices) {
            const mapped = this.mapLiveSensor(dev, loc.id, loc.name)
            nextSensors.push(mapped)
            this.bindSensorSubscription(dev, loc.id, loc.name)
          }
        } catch {
          // Location may not expose websocket alarm devices
        }
      }
    }

    this.locations = nextLocations
    this.cameras = nextCameras
    this.sensors = nextSensors
    this.connection = {
      connected: true,
      mode: 'live',
      accountLabel,
      locationCount: nextLocations.length,
      cameraCount: nextCameras.length,
      sensorCount: nextSensors.length,
      lastSyncAt: new Date().toISOString(),
    }

    this.pushEvent({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sourceType: 'system',
      deviceName: 'Ring Cloud',
      kind: 'info',
      title: 'Connected to Ring Account',
      detail: `Loaded ${nextCameras.length} camera(s) and ${nextSensors.length} sensor/device(s) across ${nextLocations.length} location(s).`,
      severity: 'success',
    })

    this.emitAllState()

    // Fetch initial snapshots lazily in background
    for (const cam of this.cameras) {
      void this.captureSnapshot(cam.id).catch(() => {})
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
      isRecording: this.recordingCameraIds.has(camId),
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
    if (this.recordingCameraIds.has(cameraId)) return
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

    const buf = await liveCam.getSnapshot()
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

  private emitAllState(): void {
    this.callbacks.onConnectionChanged(this.getConnection())
    this.callbacks.onLocationsUpdated(this.getLocations())
    this.callbacks.onCamerasUpdated(this.getCameras())
    this.callbacks.onSensorsUpdated(this.getSensors())
  }

  shutdown(): void {
    this.aiPackageService.stop()
    this.clearLiveSubscriptions()
  }
}
