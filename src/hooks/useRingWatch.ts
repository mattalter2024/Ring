import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AlertSoundPayload,
  AppSettings,
  AuthStatus,
  ConnectionStatus,
  LiveStreamSession,
  LocalRecordingItem,
  NvrStatus,
  PackageDetectionRecord,
  RingCameraInfo,
  RingLocationInfo,
  RingSensorInfo,
  SecurityEvent,
  StorageStats,
} from '@shared/types'
import { webRingWatchApi } from '@/api/webClient'
import { playAlertChime } from '@/utils/audioChime'
import { applySystemTheme } from '@/utils/theme'
import { applyClientPlatformAttribute } from '@/utils/platform'

export interface UiToast {
  id: string
  title: string
  body: string
  tone: 'ok' | 'warn' | 'err' | 'info'
}

const DEFAULT_SETTINGS: AppSettings = {
  mode: 'demo',
  recordingsDir: 'C:\\Users\\User\\Videos\\RingWatch',
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
  hasRingToken: false,
  packageAi: {
    enabled: true,
    provider: 'openai',
    openaiModel: 'gpt-4o-mini',
    geminiModel: 'gemini-3-flash-preview',
    hasOpenaiKey: false,
    hasGeminiKey: false,
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
  },
}

const DEFAULT_STORAGE_STATS: StorageStats = {
  recordingsDir: DEFAULT_SETTINGS.recordingsDir,
  activeRecordingsDir: DEFAULT_SETTINGS.recordingsDir,
  failoverRecordingsDir: DEFAULT_SETTINGS.failoverRecordingsDir,
  usingFailover: false,
  primaryOnline: true,
  totalClips: 0,
  starredClips: 0,
  totalBytes: 0,
  protectedBytes: 0,
  maxStorageGb: DEFAULT_SETTINGS.maxStorageGb,
  retentionDays: DEFAULT_SETTINGS.retentionDays,
  lowDiskWarningGb: DEFAULT_SETTINGS.lowDiskWarningGb,
  minFreeDiskGb: DEFAULT_SETTINGS.minFreeDiskGb,
  diskHealth: 'healthy',
  totalDiskBytes: null,
  freeDiskBytes: null,
  writeRateBytesPerHour: 0,
  estimatedDaysRemaining: null,
  perCameraUsage: [],
}

const DEFAULT_NVR_STATUS: NvrStatus = {
  active: false,
  segmentSeconds: DEFAULT_SETTINGS.continuousSegmentSeconds,
  totalSegmentsCaptured: 0,
  activeCameraCount: 0,
  powerSaveBlocked: false,
  usingFailoverStorage: false,
  diskHealth: 'healthy',
  watchdogChecks: 0,
  cameras: {},
}

const DEFAULT_AUTH_STATUS: AuthStatus = {
  authEnabled: false,
  authenticated: true,
  managedByEnv: false,
}

export function useRingWatch(onFocusCameraExternal?: (cameraId: string) => void) {
  const [loading, setLoading] = useState(true)
  const [authStatus, setAuthStatus] = useState<AuthStatus>(DEFAULT_AUTH_STATUS)
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

  const loadBootstrap = useCallback(async () => {
    const boot = await webRingWatchApi.getBootstrap()
    if (boot.authStatus) {
      setAuthStatus(boot.authStatus)
    }
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
  }, [])

  // Follow browser OS dark/light theme and native Windows/macOS platform styles automatically
  useEffect(() => {
    applyClientPlatformAttribute()
    const mq =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
    if (!mq) return
    applySystemTheme({ shouldUseDarkColors: mq.matches, accentColor: null })
    const onMqChange = (e: MediaQueryListEvent) => {
      applySystemTheme({ shouldUseDarkColors: e.matches, accentColor: null })
    }
    mq.addEventListener?.('change', onMqChange)
    return () => {
      mq.removeEventListener?.('change', onMqChange)
    }
  }, [])

  // Check optional login gate on initial mount
  useEffect(() => {
    let mounted = true
    void webRingWatchApi
      .getAuthStatus()
      .then(async (status) => {
        if (!mounted) return
        setAuthStatus(status)
        if (!status.authEnabled || status.authenticated) {
          await loadBootstrap()
        }
        if (mounted) setLoading(false)
      })
      .catch((err) => {
        if (!mounted) return
        pushToast(
          'Backend Unavailable',
          err instanceof Error
            ? err.message
            : 'Could not connect to RingWatch NVR & AI backend.',
          'err',
        )
        setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [loadBootstrap, pushToast])

  // Subscribe to real-time SSE updates whenever authenticated
  useEffect(() => {
    if (authStatus.authEnabled && !authStatus.authenticated) return

    const unsubs = [
      webRingWatchApi.onConnectionChanged((status) => setConnection(status)),
      webRingWatchApi.onSettingsUpdated((nextSettings) => setSettings(nextSettings)),
      webRingWatchApi.onLocationsUpdated((locs) => setLocations(locs)),
      webRingWatchApi.onCamerasUpdated((cams) => setCameras(cams)),
      webRingWatchApi.onSensorsUpdated((sens) => setSensors(sens)),
      webRingWatchApi.onSecurityEvent((ev) =>
        setEvents((prev) =>
          prev.some((e) => e.id === ev.id) ? prev : [ev, ...prev].slice(0, 500),
        ),
      ),
      webRingWatchApi.onEventsUpdated((nextEvents) => setEvents(nextEvents)),
      webRingWatchApi.onNvrStatusUpdated((nextNvr) => setNvrStatus(nextNvr)),
      webRingWatchApi.onRecordingsUpdated((recs) => setRecordings(recs)),
      webRingWatchApi.onStorageStatsUpdated((stats) => setStorageStats(stats)),
      webRingWatchApi.onPackageDetection((rec) =>
        setPackageDetections((prev) => [rec, ...prev].slice(0, 150)),
      ),
      webRingWatchApi.onPlayAlertSound((payload: AlertSoundPayload) => {
        if (payload.profile !== 'none') {
          playAlertChime(payload.profile, payload.volume)
        }
        pushToast(payload.title, payload.body, 'warn')
        if (
          payload.desktopEnabled &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted'
        ) {
          try {
            const n = new Notification(payload.title, { body: payload.body })
            n.onclick = () => {
              window.focus()
              if (payload.cameraId) {
                focusRef.current?.(payload.cameraId)
              }
            }
          } catch {
            // Ignore browser notification errors
          }
        }
      }),
      webRingWatchApi.onFocusCamera((camId: string) => {
        focusRef.current?.(camId)
      }),
      webRingWatchApi.onStreamsUpdated((sessions: LiveStreamSession[]) => {
        const next: Record<string, LiveStreamSession> = {}
        for (const s of sessions) next[s.cameraId] = s
        setStreamsByCamera(next)
      }),
    ]

    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [authStatus.authEnabled, authStatus.authenticated, pushToast])

  const login = useCallback(
    async (password: string) => {
      const res = await webRingWatchApi.login(password)
      if (res.ok) {
        const status = await webRingWatchApi.getAuthStatus()
        setAuthStatus(status)
        await loadBootstrap()
      }
      return res
    },
    [loadBootstrap],
  )

  const logout = useCallback(async () => {
    await webRingWatchApi.logout()
    const status = await webRingWatchApi.getAuthStatus()
    setAuthStatus(status)
  }, [])

  const setAuthPassword = useCallback(
    async (params: { currentPassword?: string; newPassword: string }) => {
      const res = await webRingWatchApi.setAuthPassword(params)
      if (res.ok) {
        const status = await webRingWatchApi.getAuthStatus()
        setAuthStatus(status)
      }
      return res
    },
    [],
  )

  return {
    api: webRingWatchApi,
    loading,
    authStatus,
    login,
    logout,
    setAuthPassword,
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
