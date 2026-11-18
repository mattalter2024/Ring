import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AlertSoundPayload,
  AppSettings,
  ConnectionStatus,
  LiveStreamSession,
  LocalRecordingItem,
  NvrStatus,
  PackageDetectionRecord,
  RingCameraInfo,
  RingLocationInfo,
  RingSensorInfo,
  RingWatchApi,
  SecurityEvent,
  StorageStats,
} from '@shared/types'
import { playAlertChime } from '@/utils/audioChime'

declare global {
  interface Window {
    ringWatch?: RingWatchApi
  }
}

export interface UiToast {
  id: string
  title: string
  body: string
  tone: 'ok' | 'warn' | 'err' | 'info'
}

const DEFAULT_SETTINGS: AppSettings = {
  mode: 'demo',
  recordingsDir: 'C:\\Users\\User\\Videos\\RingWatch',
  defaultCaptureSeconds: 30,
  autoRecordOnMotion: true,
  autoRecordOnDoorbell: true,
  autoRecordOnPackage: true,
  continuousSegmentSeconds: 120,
  continuousSkipBatteryCams: false,
  continuousAutoStart: false,
  continuousCameraIds: [],
  maxStorageGb: 25,
  retentionDays: 30,
  ffmpegPath: '',
  minimizeToTray: true,
  startMinimized: false,
  hasRingToken: false,
  packageAi: {
    enabled: true,
    provider: 'openai',
    openaiModel: 'gpt-4o-mini',
    geminiModel: 'gemini-3.5-flash-lite',
    hasOpenaiKey: false,
    hasGeminiKey: false,
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
  },
}

const DEFAULT_STORAGE_STATS: StorageStats = {
  recordingsDir: DEFAULT_SETTINGS.recordingsDir,
  totalClips: 0,
  starredClips: 0,
  totalBytes: 0,
  maxStorageGb: DEFAULT_SETTINGS.maxStorageGb,
  retentionDays: DEFAULT_SETTINGS.retentionDays,
  freeDiskBytes: null,
}

const DEFAULT_NVR_STATUS: NvrStatus = {
  active: false,
  segmentSeconds: DEFAULT_SETTINGS.continuousSegmentSeconds,
  totalSegmentsCaptured: 0,
  activeCameraCount: 0,
  cameras: {},
}

function createBrowserPreviewFallback(): {
  connection: ConnectionStatus
  locations: RingLocationInfo[]
  cameras: RingCameraInfo[]
  sensors: RingSensorInfo[]
  events: SecurityEvent[]
} {
  const now = new Date().toISOString()
  return {
    connection: {
      connected: true,
      mode: 'demo',
      accountLabel: 'Browser Preview (Demo Mode)',
      locationCount: 1,
      cameraCount: 3,
      sensorCount: 5,
      lastSyncAt: now,
    },
    locations: [
      { id: 'demo-loc-home', name: 'Maple Street Home', hasAlarm: true, alarmMode: 'none' },
    ],
    cameras: [
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
        lastSnapshotDataUrl: './demo/front_porch.jpg',
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
        lastSnapshotDataUrl: './demo/driveway.jpg',
        lastSnapshotAt: now,
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
        lastSnapshotDataUrl: './demo/back_patio.jpg',
        lastSnapshotAt: now,
        demoImage: 'back_patio.jpg',
      },
    ],
    sensors: [
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
    ],
    events: [
      {
        id: 'preview-ev-1',
        timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        sourceType: 'camera',
        deviceId: 'demo-cam-front',
        deviceName: 'Front Porch Doorbell Pro',
        kind: 'motion',
        title: 'Motion Detected — Front Porch',
        detail: 'Person approached porch entrance; snapshot refreshed.',
        severity: 'warning',
        snapshotDataUrl: './demo/front_porch.jpg',
      },
    ],
  }
}

export function useRingWatch(onFocusCameraExternal?: (cameraId: string) => void) {
  const isElectron = Boolean(window.ringWatch)
  const [loading, setLoading] = useState(true)
  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    mode: 'demo',
    locationCount: 0,
    cameraCount: 0,
    sensorCount: 0,
  })
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [storageStats, setStorageStats] = useState<StorageStats>(DEFAULT_STORAGE_STATS)
  const [nvrStatus, setNvrStatus] = useState<NvrStatus>(DEFAULT_NVR_STATUS)
  const [locations, setLocations] = useState<RingLocationInfo[]>([])
  const [cameras, setCameras] = useState<RingCameraInfo[]>([])
  const [sensors, setSensors] = useState<RingSensorInfo[]>([])
  const [events, setEvents] = useState<SecurityEvent[]>([])
  const [recordings, setRecordings] = useState<LocalRecordingItem[]>([])
  const [packageDetections, setPackageDetections] = useState<PackageDetectionRecord[]>([])
  const [streamsByCamera, setStreamsByCamera] = useState<Record<string, LiveStreamSession>>({})
  const [toasts, setToasts] = useState<UiToast[]>([])

  const focusRef = useRef(onFocusCameraExternal)
  focusRef.current = onFocusCameraExternal

  const pushToast = useCallback(
    (title: string, body: string, tone: UiToast['tone'] = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setToasts((prev) => [...prev.slice(-3), { id, title, body, tone }])
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, 5000)
    },
    [],
  )

  useEffect(() => {
    const api = window.ringWatch
    if (!api) {
      const fallback = createBrowserPreviewFallback()
      setConnection(fallback.connection)
      setLocations(fallback.locations)
      setCameras(fallback.cameras)
      setSensors(fallback.sensors)
      setEvents(fallback.events)
      setLoading(false)
      return
    }

    let mounted = true
    void api
      .getBootstrap()
      .then((boot) => {
        if (!mounted) return
        setConnection(boot.connection)
        setSettings(boot.settings)
        setStorageStats(boot.storageStats)
        setNvrStatus(boot.nvrStatus ?? DEFAULT_NVR_STATUS)
        setLocations(boot.locations)
        setCameras(boot.cameras)
        setSensors(boot.sensors)
        setEvents(boot.events)
        setRecordings(boot.recordings)
        setPackageDetections(boot.packageDetections)
        const streamMap: Record<string, LiveStreamSession> = {}
        for (const s of boot.activeStreams) streamMap[s.cameraId] = s
        setStreamsByCamera(streamMap)
        setLoading(false)
      })
      .catch((err) => {
        if (!mounted) return
        pushToast(
          'Bootstrap Error',
          err instanceof Error ? err.message : String(err),
          'err',
        )
        setLoading(false)
      })

    const unsubs = [
      api.onConnectionChanged((status) => setConnection(status)),
      api.onSettingsUpdated((nextSettings) => setSettings(nextSettings)),
      api.onLocationsUpdated((locs) => setLocations(locs)),
      api.onCamerasUpdated((cams) => setCameras(cams)),
      api.onSensorsUpdated((sens) => setSensors(sens)),
      api.onSecurityEvent((ev) =>
        setEvents((prev) =>
          prev.some((e) => e.id === ev.id) ? prev : [ev, ...prev].slice(0, 500),
        ),
      ),
      api.onEventsUpdated((nextEvents) => setEvents(nextEvents)),
      api.onNvrStatusUpdated((nextNvr) => setNvrStatus(nextNvr)),
      api.onRecordingsUpdated((recs) => setRecordings(recs)),
      api.onStorageStatsUpdated((stats) => setStorageStats(stats)),
      api.onPackageDetection((rec) =>
        setPackageDetections((prev) => [rec, ...prev].slice(0, 150)),
      ),
      api.onPlayAlertSound((payload: AlertSoundPayload) => {
        playAlertChime(payload.profile, payload.volume)
        pushToast(payload.title, payload.body, 'warn')
      }),
      api.onFocusCamera((camId: string) => {
        focusRef.current?.(camId)
      }),
    ]

    return () => {
      mounted = false
      for (const unsub of unsubs) unsub()
    }
  }, [pushToast])

  return {
    isElectron,
    api: window.ringWatch,
    loading,
    connection,
    setConnection,
    settings,
    setSettings,
    storageStats,
    setStorageStats,
    nvrStatus,
    setNvrStatus,
    locations,
    setLocations,
    cameras,
    setCameras,
    sensors,
    setSensors,
    events,
    setEvents,
    recordings,
    setRecordings,
    packageDetections,
    setPackageDetections,
    streamsByCamera,
    setStreamsByCamera,
    toasts,
    pushToast,
  }
}
