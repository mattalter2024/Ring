import type {
  AlertSoundPayload,
  AppMode,
  AppSettings,
  AppSettingsPatch,
  AuthStatus,
  CloudRecordingItem,
  ConnectionStatus,
  LiveStreamSession,
  LocalRecordingItem,
  NvrStatus,
  PackageDetectionRecord,
  RingAuthStepResult,
  RingCameraInfo,
  RingLocationInfo,
  RingSensorInfo,
  RingWatchApi,
  RingWatchBootstrap,
  SecurityEvent,
  StorageDriveInfo,
  StorageStats,
  SystemThemeInfo,
} from '@shared/types'

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function apiJson<T>(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  }
  const res = await fetch(url, init)
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`
    throw new ApiError(res.status, errMsg)
  }
  return parsed as T
}

const SSE_CHANNELS = [
  'connection-changed',
  'settings-updated',
  'cameras-updated',
  'sensors-updated',
  'locations-updated',
  'security-event',
  'events-updated',
  'nvr-status-updated',
  'recordings-updated',
  'storage-stats-updated',
  'package-detection',
  'play-alert-sound',
  'focus-camera',
  'streams-updated',
] as const

class SseHub {
  private source: EventSource | null = null
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  private activeCount = 0

  private ensureConnected(): void {
    if (this.source || typeof EventSource === 'undefined') return
    const es = new EventSource('/api/events', { withCredentials: true })
    for (const channel of SSE_CHANNELS) {
      es.addEventListener(channel, (ev) => {
        const msg = ev as MessageEvent<string>
        try {
          const payload = JSON.parse(msg.data)
          const set = this.listeners.get(channel)
          if (!set) return
          for (const cb of Array.from(set)) {
            cb(payload)
          }
        } catch {
          // Ignore malformed event frames
        }
      })
    }
    this.source = es
  }

  reconnect(): void {
    if (this.source) {
      this.source.close()
      this.source = null
    }
    if (this.activeCount > 0) {
      this.ensureConnected()
    }
  }

  disconnect(): void {
    if (this.source) {
      this.source.close()
      this.source = null
    }
  }

  subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    const wrapped = cb as (payload: unknown) => void
    set.add(wrapped)
    this.activeCount++
    this.ensureConnected()

    return () => {
      set?.delete(wrapped)
      this.activeCount = Math.max(0, this.activeCount - 1)
      if (this.activeCount === 0) {
        this.disconnect()
      }
    }
  }
}

export const sseHub = new SseHub()

export const webRingWatchApi: RingWatchApi = {
  getAuthStatus: () => apiJson<AuthStatus>('/api/auth/status'),
  login: async (password: string) => {
    try {
      const res = await apiJson<{ ok: boolean; error?: string }>('/api/auth/login', {
        method: 'POST',
        body: { password },
      })
      if (res.ok) sseHub.reconnect()
      return res
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Login failed',
      }
    }
  },
  logout: async () => {
    await apiJson('/api/auth/logout', { method: 'POST' })
    sseHub.disconnect()
  },
  setAuthPassword: async (params) => {
    try {
      return await apiJson<{ ok: boolean; authEnabled: boolean; error?: string }>(
        '/api/auth/password',
        { method: 'POST', body: params },
      )
    } catch (err) {
      return {
        ok: false,
        authEnabled: false,
        error: err instanceof Error ? err.message : 'Failed to update password',
      }
    }
  },

  getBootstrap: () => apiJson<RingWatchBootstrap>('/api/bootstrap'),
  connectWithToken: (refreshToken: string) =>
    apiJson<ConnectionStatus>('/api/connection/token', {
      method: 'POST',
      body: { refreshToken },
    }),
  loginWithCredentials: (params) =>
    apiJson<RingAuthStepResult>('/api/connection/login', {
      method: 'POST',
      body: params,
    }),
  disconnectRing: () =>
    apiJson<ConnectionStatus>('/api/connection/disconnect', { method: 'POST' }),
  switchMode: (mode: AppMode) =>
    apiJson<ConnectionStatus>('/api/connection/mode', {
      method: 'POST',
      body: { mode },
    }),
  refreshDevices: () =>
    apiJson<{
      locations: RingLocationInfo[]
      cameras: RingCameraInfo[]
      sensors: RingSensorInfo[]
    }>('/api/connection/refresh', { method: 'POST' }),

  startLiveStream: (cameraId: string) =>
    apiJson<LiveStreamSession>(
      `/api/cameras/${encodeURIComponent(cameraId)}/stream/start`,
      { method: 'POST' },
    ),
  stopLiveStream: async (cameraId: string) => {
    await apiJson(`/api/cameras/${encodeURIComponent(cameraId)}/stream/stop`, {
      method: 'POST',
    })
  },
  captureSnapshot: (cameraId: string) =>
    apiJson<{ dataUrl: string; capturedAt: string }>(
      `/api/cameras/${encodeURIComponent(cameraId)}/snapshot`,
      { method: 'POST' },
    ),
  toggleCameraLight: (cameraId: string, on: boolean) =>
    apiJson<RingCameraInfo>(
      `/api/cameras/${encodeURIComponent(cameraId)}/light`,
      { method: 'POST', body: { on } },
    ),
  toggleCameraSiren: (cameraId: string, on: boolean) =>
    apiJson<RingCameraInfo>(
      `/api/cameras/${encodeURIComponent(cameraId)}/siren`,
      { method: 'POST', body: { on } },
    ),
  setAlarmMode: (locationId: string, mode: 'none' | 'some' | 'all') =>
    apiJson<RingLocationInfo>(
      `/api/locations/${encodeURIComponent(locationId)}/alarm`,
      { method: 'POST', body: { mode } },
    ),

  getNvrStatus: () => apiJson<NvrStatus>('/api/nvr/status'),
  startAllCameraRecording: (cameraIds?: string[]) =>
    apiJson<NvrStatus>('/api/nvr/start', {
      method: 'POST',
      body: { cameraIds },
    }),
  stopAllCameraRecording: () =>
    apiJson<NvrStatus>('/api/nvr/stop', { method: 'POST' }),
  toggleCameraContinuousRecording: (cameraId: string, enable: boolean) =>
    apiJson<NvrStatus>(`/api/nvr/camera/${encodeURIComponent(cameraId)}`, {
      method: 'POST',
      body: { enable },
    }),
  syncCloudEventsToTimeline: () =>
    apiJson<{ addedCount: number; events: SecurityEvent[] }>(
      '/api/timeline/sync-cloud',
      { method: 'POST' },
    ),

  captureRecording: (params) =>
    apiJson<LocalRecordingItem>('/api/recordings/capture', {
      method: 'POST',
      body: params,
    }),
  listLocalRecordings: () => apiJson<LocalRecordingItem[]>('/api/recordings'),
  deleteLocalRecording: async (recordingId: string) => {
    await apiJson(`/api/recordings/${encodeURIComponent(recordingId)}`, {
      method: 'DELETE',
    })
  },
  toggleRecordingStar: (recordingId: string) =>
    apiJson<LocalRecordingItem>(
      `/api/recordings/${encodeURIComponent(recordingId)}/star`,
      { method: 'POST' },
    ),
  exportRecording: async (recordingId: string) => {
    // Trigger native browser download from the backend server
    const url = `/api/recordings/${encodeURIComponent(recordingId)}/download`
    const a = document.createElement('a')
    a.href = url
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    return url
  },
  exportEvidenceBundle: (recordingId: string) =>
    apiJson<{ videoPath: string; manifestPath: string; sha256: string } | null>(
      `/api/recordings/${encodeURIComponent(recordingId)}/evidence`,
      { method: 'POST' },
    ),
  importLocalVideos: async () => [],
  getStorageStats: () => apiJson<StorageStats>('/api/storage/stats'),
  listStorageDrives: () => apiJson<StorageDriveInfo[]>('/api/storage/drives'),
  setPrimaryStorageDrive: (drivePath: string) =>
    apiJson<{ settings: AppSettings; stats: StorageStats }>(
      '/api/storage/primary',
      { method: 'POST', body: { drivePath } },
    ),
  setFailoverStorageDrive: (drivePath: string) =>
    apiJson<{ settings: AppSettings; stats: StorageStats }>(
      '/api/storage/failover',
      { method: 'POST', body: { drivePath } },
    ),
  clearFailoverStorage: () =>
    apiJson<{ settings: AppSettings; stats: StorageStats }>(
      '/api/storage/failover',
      { method: 'DELETE' },
    ),
  rescanLocalStorage: () =>
    apiJson<{ recordings: LocalRecordingItem[]; stats: StorageStats }>(
      '/api/storage/rescan',
      { method: 'POST' },
    ),
  pruneLocalStorage: () =>
    apiJson<{ prunedCount: number; freedBytes: number; stats: StorageStats }>(
      '/api/storage/prune',
      { method: 'POST' },
    ),
  openRecordingInFolder: async (recordingId: string) => {
    await apiJson(
      `/api/recordings/${encodeURIComponent(recordingId)}/open-folder`,
      { method: 'POST' },
    )
  },
  openRecordingsRootFolder: async () => {
    await apiJson('/api/recordings/open-folder', { method: 'POST' })
  },
  listCloudRecordings: (cameraId: string) =>
    apiJson<CloudRecordingItem[]>(
      `/api/cameras/${encodeURIComponent(cameraId)}/cloud-recordings`,
    ),
  downloadCloudRecording: (cameraId: string, dingId: string) =>
    apiJson<LocalRecordingItem>(
      `/api/cameras/${encodeURIComponent(cameraId)}/cloud-recordings/${encodeURIComponent(dingId)}/download`,
      { method: 'POST' },
    ),

  scanCameraForPackages: (cameraId: string, trigger) =>
    apiJson<PackageDetectionRecord>('/api/ai/scan', {
      method: 'POST',
      body: { cameraId, trigger },
    }),
  listPackageDetections: () =>
    apiJson<PackageDetectionRecord[]>('/api/ai/detections'),
  clearPackageDetections: async () => {
    await apiJson('/api/ai/detections', { method: 'DELETE' })
  },
  testAiConnection: () =>
    apiJson<{ ok: boolean; message: string; latencyMs?: number }>(
      '/api/ai/test-connection',
      { method: 'POST' },
    ),
  testPackageAlert: async () => {
    await apiJson('/api/ai/test-alert', { method: 'POST' })
  },

  simulateDemoEvent: async (kind) => {
    await apiJson('/api/demo/simulate', { method: 'POST', body: { kind } })
  },

  updateSettings: (patch: AppSettingsPatch) =>
    apiJson<AppSettings>('/api/settings', { method: 'PATCH', body: patch }),
  chooseRecordingsFolder: async () => null,
  chooseFailoverFolder: async () => null,

  onConnectionChanged: (cb) => sseHub.subscribe<ConnectionStatus>('connection-changed', cb),
  onSettingsUpdated: (cb) => sseHub.subscribe<AppSettings>('settings-updated', cb),
  onCamerasUpdated: (cb) => sseHub.subscribe<RingCameraInfo[]>('cameras-updated', cb),
  onSensorsUpdated: (cb) => sseHub.subscribe<RingSensorInfo[]>('sensors-updated', cb),
  onLocationsUpdated: (cb) => sseHub.subscribe<RingLocationInfo[]>('locations-updated', cb),
  onSecurityEvent: (cb) => sseHub.subscribe<SecurityEvent>('security-event', cb),
  onEventsUpdated: (cb) => sseHub.subscribe<SecurityEvent[]>('events-updated', cb),
  onNvrStatusUpdated: (cb) => sseHub.subscribe<NvrStatus>('nvr-status-updated', cb),
  onRecordingsUpdated: (cb) => sseHub.subscribe<LocalRecordingItem[]>('recordings-updated', cb),
  onStorageStatsUpdated: (cb) => sseHub.subscribe<StorageStats>('storage-stats-updated', cb),
  onPackageDetection: (cb) => sseHub.subscribe<PackageDetectionRecord>('package-detection', cb),
  onPlayAlertSound: (cb) => sseHub.subscribe<AlertSoundPayload>('play-alert-sound', cb),
  onFocusCamera: (cb) => sseHub.subscribe<string>('focus-camera', cb),
  onStreamsUpdated: (cb) => sseHub.subscribe<LiveStreamSession[]>('streams-updated', cb),
  onSystemThemeChanged: (_cb: (theme: SystemThemeInfo) => void) => () => {},
}
