export type AppMode = 'demo' | 'live'

export type AiProvider = 'openai' | 'gemini'

export type AlertSoundProfile =
  | 'crisp-chime'
  | 'doorbell-double'
  | 'soft-pulse'
  | 'urgent-radar'
  | 'none'

export type AlarmMode = 'none' | 'some' | 'all' | 'unknown'

export interface ConnectionStatus {
  connected: boolean
  mode: AppMode
  accountLabel?: string
  locationCount: number
  cameraCount: number
  sensorCount: number
  error?: string
  lastSyncAt?: string
}

export interface RingLocationInfo {
  id: string
  name: string
  hasAlarm: boolean
  alarmMode: AlarmMode
}

export interface RingCameraInfo {
  id: string
  name: string
  locationId: string
  locationName: string
  model: string
  kind: string
  online: boolean
  batteryPercent: number | null
  rssi: number | null
  hasLight: boolean
  lightOn: boolean
  hasSiren: boolean
  sirenOn: boolean
  isDoorbell: boolean
  isStreaming: boolean
  isRecording: boolean
  lastSnapshotDataUrl?: string
  lastSnapshotAt?: string
  lastMotionAt?: string
  demoImage?: string
}

export type SensorCategory =
  | 'contact'
  | 'motion'
  | 'flood'
  | 'smoke'
  | 'keypad'
  | 'lock'
  | 'light'
  | 'base-station'
  | 'other'

export interface RingSensorInfo {
  id: string
  zid: string
  name: string
  locationId: string
  locationName: string
  deviceType: string
  category: SensorCategory
  faulted: boolean
  tamper: boolean
  batteryPercent: number | null
  batteryStatus?: string
  online: boolean
  statusLabel: string
  lastUpdatedAt: string
}

export type SecurityEventKind =
  | 'motion'
  | 'ding'
  | 'contact-open'
  | 'contact-close'
  | 'flood'
  | 'alarm-mode'
  | 'package-detected'
  | 'package-cleared'
  | 'recording-saved'
  | 'storage-alert'
  | 'nvr-health'
  | 'info'

export interface SecurityEvent {
  id: string
  timestamp: string
  sourceType: 'camera' | 'sensor' | 'alarm' | 'ai-package' | 'recording' | 'system'
  deviceId?: string
  deviceName: string
  kind: SecurityEventKind
  title: string
  detail: string
  severity: 'info' | 'warning' | 'alert' | 'success'
  snapshotDataUrl?: string
}

export interface LocalRecordingItem {
  id: string
  cameraId: string
  cameraName: string
  filePath: string
  fileName: string
  createdAt: string
  durationSeconds: number
  sizeBytes: number
  trigger:
    | 'manual'
    | 'motion'
    | 'ding'
    | 'package'
    | 'continuous'
    | 'cloud-download'
    | 'imported'
  starred?: boolean
  notes?: string
  thumbnailDataUrl?: string
  playbackUrl?: string
}

export type DiskHealthStatus = 'healthy' | 'warning' | 'critical' | 'offline'

export interface StorageDriveInfo {
  id: string
  path: string
  label: string
  driveType: 'fixed' | 'removable' | 'network' | 'unknown'
  totalBytes: number | null
  freeBytes: number | null
  usedBytes: number | null
  writable: boolean
  isPrimary: boolean
  isFailover: boolean
}

export interface CameraStorageUsage {
  cameraId: string
  cameraName: string
  clipCount: number
  totalBytes: number
  protectedBytes: number
  oldestClipAt?: string
  newestClipAt?: string
}

export interface NvrCameraStatus {
  cameraId: string
  cameraName: string
  state: 'connecting' | 'recording' | 'reconnecting' | 'stalled' | 'stopped' | 'error'
  startedAt?: string
  currentSegmentStartedAt?: string
  lastSegmentAt?: string
  segmentsCaptured: number
  reconnectCount: number
  bytesRecorded: number
  estimatedBitrateKbps?: number
  lastError?: string
}

export interface NvrStatus {
  active: boolean
  startedAt?: string
  segmentSeconds: number
  totalSegmentsCaptured: number
  activeCameraCount: number
  powerSaveBlocked: boolean
  usingFailoverStorage: boolean
  diskHealth: DiskHealthStatus
  watchdogChecks: number
  lastHealthCheckAt?: string
  cameras: Record<string, NvrCameraStatus>
}

export interface StorageStats {
  recordingsDir: string
  activeRecordingsDir: string
  failoverRecordingsDir: string
  usingFailover: boolean
  primaryOnline: boolean
  totalClips: number
  starredClips: number
  totalBytes: number
  protectedBytes: number
  maxStorageGb: number
  retentionDays: number
  lowDiskWarningGb: number
  minFreeDiskGb: number
  diskHealth: DiskHealthStatus
  totalDiskBytes: number | null
  freeDiskBytes: number | null
  writeRateBytesPerHour: number
  estimatedDaysRemaining: number | null
  oldestClipAt?: string
  newestClipAt?: string
  perCameraUsage: CameraStorageUsage[]
}

export interface CloudRecordingItem {
  id: string
  cameraId: string
  cameraName: string
  kind: string
  createdAt: string
  durationSeconds: number
  favorite: boolean
  cvPackageDetected?: boolean
  downloadedLocalId?: string
}

export interface PackageAiConfig {
  enabled: boolean
  provider: AiProvider
  openaiModel: string
  geminiModel: string
  hasOpenaiKey: boolean
  hasGeminiKey: boolean
  monitoredCameraIds: string[]
  triggerOnMotion: boolean
  triggerOnDoorbell: boolean
  intervalMinutes: number
  minConfidence: number
  cooldownMinutes: number
  desktopNotifications: boolean
  alertSound: AlertSoundProfile
  alertVolume: number
  customPromptHint: string
}

export interface PackageAiConfigPatch {
  enabled?: boolean
  provider?: AiProvider
  openaiModel?: string
  geminiModel?: string
  openaiApiKey?: string
  geminiApiKey?: string
  monitoredCameraIds?: string[]
  triggerOnMotion?: boolean
  triggerOnDoorbell?: boolean
  intervalMinutes?: number
  minConfidence?: number
  cooldownMinutes?: number
  desktopNotifications?: boolean
  alertSound?: AlertSoundProfile
  alertVolume?: number
  customPromptHint?: string
}

export interface PackageDetectionRecord {
  id: string
  cameraId: string
  cameraName: string
  timestamp: string
  provider: AiProvider | 'demo-vision'
  model: string
  trigger: 'motion' | 'doorbell' | 'interval' | 'manual'
  packageDetected: boolean
  confidence: number
  packageCount: number
  carrierHint: string | null
  placement: string | null
  personPresent: boolean
  summary: string
  snapshotDataUrl?: string
  notified: boolean
  latencyMs: number
  rawError?: string
}

export interface AppSettings {
  mode: AppMode
  recordingsDir: string
  failoverRecordingsDir: string
  organizeByDateFolder: boolean
  defaultCaptureSeconds: number
  autoRecordOnMotion: boolean
  autoRecordOnDoorbell: boolean
  autoRecordOnPackage: boolean
  continuousSegmentSeconds: number
  continuousSkipBatteryCams: boolean
  continuousAutoStart: boolean
  continuousCameraIds: string[]
  maxStorageGb: number
  retentionDays: number
  lowDiskWarningGb: number
  minFreeDiskGb: number
  nvrNotificationsEnabled: boolean
  preventSleepWhileRecording: boolean
  launchAtLogin: boolean
  ffmpegPath: string
  minimizeToTray: boolean
  startMinimized: boolean
  hasRingToken: boolean
  packageAi: PackageAiConfig
}

export interface AppSettingsPatch {
  mode?: AppMode
  recordingsDir?: string
  failoverRecordingsDir?: string
  organizeByDateFolder?: boolean
  defaultCaptureSeconds?: number
  autoRecordOnMotion?: boolean
  autoRecordOnDoorbell?: boolean
  autoRecordOnPackage?: boolean
  continuousSegmentSeconds?: number
  continuousSkipBatteryCams?: boolean
  continuousAutoStart?: boolean
  continuousCameraIds?: string[]
  maxStorageGb?: number
  retentionDays?: number
  lowDiskWarningGb?: number
  minFreeDiskGb?: number
  nvrNotificationsEnabled?: boolean
  preventSleepWhileRecording?: boolean
  launchAtLogin?: boolean
  ffmpegPath?: string
  minimizeToTray?: boolean
  startMinimized?: boolean
  packageAi?: PackageAiConfigPatch
}

export interface LiveStreamSession {
  cameraId: string
  mode: 'hls' | 'demo'
  streamUrl: string
  startedAt: string
  audioEnabled: boolean
}

export interface RingAuthStepResult {
  status: 'authenticated' | '2fa-required' | 'error'
  prompt?: string
  error?: string
  connection?: ConnectionStatus
}

export interface AlertSoundPayload {
  profile: AlertSoundProfile
  volume: number
  title: string
  body: string
  cameraId?: string
  desktopEnabled?: boolean
}

export interface SystemThemeInfo {
  shouldUseDarkColors: boolean
  accentColor: string | null
}

export interface AuthStatus {
  authEnabled: boolean
  authenticated: boolean
  managedByEnv: boolean
}

export interface RingWatchBootstrap {
  connection: ConnectionStatus
  settings: AppSettings
  storageStats: StorageStats
  nvrStatus: NvrStatus
  locations: RingLocationInfo[]
  cameras: RingCameraInfo[]
  sensors: RingSensorInfo[]
  events: SecurityEvent[]
  recordings: LocalRecordingItem[]
  packageDetections: PackageDetectionRecord[]
  activeStreams: LiveStreamSession[]
  authStatus?: AuthStatus
  systemTheme?: SystemThemeInfo
}

export interface RingWatchApi {
  getAuthStatus: () => Promise<AuthStatus>
  login: (password: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => Promise<void>
  setAuthPassword: (params: {
    currentPassword?: string
    newPassword: string
  }) => Promise<{ ok: boolean; authEnabled: boolean; error?: string }>

  getBootstrap: () => Promise<RingWatchBootstrap>
  connectWithToken: (refreshToken: string) => Promise<ConnectionStatus>
  loginWithCredentials: (params: {
    email: string
    password: string
    twoFactorCode?: string
  }) => Promise<RingAuthStepResult>
  disconnectRing: () => Promise<ConnectionStatus>
  switchMode: (mode: AppMode) => Promise<ConnectionStatus>
  refreshDevices: () => Promise<{
    locations: RingLocationInfo[]
    cameras: RingCameraInfo[]
    sensors: RingSensorInfo[]
  }>

  startLiveStream: (cameraId: string) => Promise<LiveStreamSession>
  stopLiveStream: (cameraId: string) => Promise<void>
  captureSnapshot: (cameraId: string) => Promise<{ dataUrl: string; capturedAt: string }>
  toggleCameraLight: (cameraId: string, on: boolean) => Promise<RingCameraInfo>
  toggleCameraSiren: (cameraId: string, on: boolean) => Promise<RingCameraInfo>
  setAlarmMode: (locationId: string, mode: 'none' | 'some' | 'all') => Promise<RingLocationInfo>

  getNvrStatus: () => Promise<NvrStatus>
  startAllCameraRecording: (cameraIds?: string[]) => Promise<NvrStatus>
  stopAllCameraRecording: () => Promise<NvrStatus>
  toggleCameraContinuousRecording: (
    cameraId: string,
    enable: boolean,
  ) => Promise<NvrStatus>
  syncCloudEventsToTimeline: () => Promise<{
    addedCount: number
    events: SecurityEvent[]
  }>

  captureRecording: (params: {
    cameraId: string
    durationSeconds: number
    trigger?: LocalRecordingItem['trigger']
  }) => Promise<LocalRecordingItem>
  listLocalRecordings: () => Promise<LocalRecordingItem[]>
  deleteLocalRecording: (recordingId: string) => Promise<void>
  toggleRecordingStar: (recordingId: string) => Promise<LocalRecordingItem>
  exportRecording: (recordingId: string) => Promise<string | null>
  exportEvidenceBundle: (recordingId: string) => Promise<{
    videoPath: string
    manifestPath: string
    sha256: string
  } | null>
  importLocalVideos: () => Promise<LocalRecordingItem[]>
  getStorageStats: () => Promise<StorageStats>
  listStorageDrives: () => Promise<StorageDriveInfo[]>
  setPrimaryStorageDrive: (drivePath: string) => Promise<{
    settings: AppSettings
    stats: StorageStats
  }>
  setFailoverStorageDrive: (drivePath: string) => Promise<{
    settings: AppSettings
    stats: StorageStats
  }>
  clearFailoverStorage: () => Promise<{
    settings: AppSettings
    stats: StorageStats
  }>
  rescanLocalStorage: () => Promise<{
    recordings: LocalRecordingItem[]
    stats: StorageStats
  }>
  pruneLocalStorage: () => Promise<{
    prunedCount: number
    freedBytes: number
    stats: StorageStats
  }>
  openRecordingInFolder: (recordingId: string) => Promise<void>
  openRecordingsRootFolder: () => Promise<void>
  listCloudRecordings: (cameraId: string) => Promise<CloudRecordingItem[]>
  downloadCloudRecording: (cameraId: string, dingId: string) => Promise<LocalRecordingItem>

  scanCameraForPackages: (
    cameraId: string,
    trigger?: PackageDetectionRecord['trigger'],
  ) => Promise<PackageDetectionRecord>
  listPackageDetections: () => Promise<PackageDetectionRecord[]>
  clearPackageDetections: () => Promise<void>
  testAiConnection: () => Promise<{ ok: boolean; message: string; latencyMs?: number }>
  testPackageAlert: () => Promise<void>

  simulateDemoEvent: (
    kind: 'doorbell' | 'motion' | 'contact-open' | 'package-delivery',
  ) => Promise<void>

  updateSettings: (patch: AppSettingsPatch) => Promise<AppSettings>
  chooseRecordingsFolder: () => Promise<string | null>
  chooseFailoverFolder: () => Promise<string | null>

  onConnectionChanged: (cb: (status: ConnectionStatus) => void) => () => void
  onSettingsUpdated: (cb: (settings: AppSettings) => void) => () => void
  onCamerasUpdated: (cb: (cameras: RingCameraInfo[]) => void) => () => void
  onSensorsUpdated: (cb: (sensors: RingSensorInfo[]) => void) => () => void
  onLocationsUpdated: (cb: (locations: RingLocationInfo[]) => void) => () => void
  onSecurityEvent: (cb: (event: SecurityEvent) => void) => () => void
  onEventsUpdated: (cb: (events: SecurityEvent[]) => void) => () => void
  onNvrStatusUpdated: (cb: (status: NvrStatus) => void) => () => void
  onRecordingsUpdated: (cb: (recordings: LocalRecordingItem[]) => void) => () => void
  onStorageStatsUpdated: (cb: (stats: StorageStats) => void) => () => void
  onPackageDetection: (cb: (record: PackageDetectionRecord) => void) => () => void
  onPlayAlertSound: (cb: (payload: AlertSoundPayload) => void) => () => void
  onFocusCamera: (cb: (cameraId: string) => void) => () => void
  onStreamsUpdated: (cb: (streams: LiveStreamSession[]) => void) => () => void
  onSystemThemeChanged: (cb: (theme: SystemThemeInfo) => void) => () => void
}
