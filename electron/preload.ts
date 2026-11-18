import { contextBridge, ipcRenderer } from 'electron'
import type {
  AlertSoundPayload,
  AppMode,
  AppSettingsPatch,
  ConnectionStatus,
  LocalRecordingItem,
  PackageDetectionRecord,
  RingCameraInfo,
  RingLocationInfo,
  RingSensorInfo,
  RingWatchApi,
  SecurityEvent,
  StorageStats,
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: RingWatchApi = {
  getBootstrap: () => ipcRenderer.invoke('ringwatch:get-bootstrap'),
  connectWithToken: (refreshToken: string) =>
    ipcRenderer.invoke('ringwatch:connect-token', refreshToken),
  loginWithCredentials: (params) =>
    ipcRenderer.invoke('ringwatch:login-credentials', params),
  disconnectRing: () => ipcRenderer.invoke('ringwatch:disconnect'),
  switchMode: (mode: AppMode) => ipcRenderer.invoke('ringwatch:switch-mode', mode),
  refreshDevices: () => ipcRenderer.invoke('ringwatch:refresh-devices'),

  startLiveStream: (cameraId: string) =>
    ipcRenderer.invoke('ringwatch:start-stream', cameraId),
  stopLiveStream: (cameraId: string) =>
    ipcRenderer.invoke('ringwatch:stop-stream', cameraId),
  captureSnapshot: (cameraId: string) =>
    ipcRenderer.invoke('ringwatch:capture-snapshot', cameraId),
  toggleCameraLight: (cameraId: string, on: boolean) =>
    ipcRenderer.invoke('ringwatch:toggle-light', { cameraId, on }),
  toggleCameraSiren: (cameraId: string, on: boolean) =>
    ipcRenderer.invoke('ringwatch:toggle-siren', { cameraId, on }),
  setAlarmMode: (locationId: string, mode: 'none' | 'some' | 'all') =>
    ipcRenderer.invoke('ringwatch:set-alarm-mode', { locationId, mode }),

  captureRecording: (params) =>
    ipcRenderer.invoke('ringwatch:capture-recording', params),
  listLocalRecordings: () => ipcRenderer.invoke('ringwatch:list-recordings'),
  deleteLocalRecording: (recordingId: string) =>
    ipcRenderer.invoke('ringwatch:delete-recording', recordingId),
  toggleRecordingStar: (recordingId: string) =>
    ipcRenderer.invoke('ringwatch:toggle-recording-star', recordingId),
  exportRecording: (recordingId: string) =>
    ipcRenderer.invoke('ringwatch:export-recording', recordingId),
  importLocalVideos: () => ipcRenderer.invoke('ringwatch:import-videos'),
  getStorageStats: () => ipcRenderer.invoke('ringwatch:get-storage-stats'),
  rescanLocalStorage: () => ipcRenderer.invoke('ringwatch:rescan-storage'),
  pruneLocalStorage: () => ipcRenderer.invoke('ringwatch:prune-storage'),
  openRecordingInFolder: (recordingId: string) =>
    ipcRenderer.invoke('ringwatch:open-recording-folder', recordingId),
  openRecordingsRootFolder: () =>
    ipcRenderer.invoke('ringwatch:open-recordings-root'),
  listCloudRecordings: (cameraId: string) =>
    ipcRenderer.invoke('ringwatch:list-cloud-recordings', cameraId),
  downloadCloudRecording: (cameraId: string, dingId: string) =>
    ipcRenderer.invoke('ringwatch:download-cloud-recording', { cameraId, dingId }),

  scanCameraForPackages: (cameraId: string, trigger) =>
    ipcRenderer.invoke('ringwatch:scan-packages', { cameraId, trigger }),
  listPackageDetections: () =>
    ipcRenderer.invoke('ringwatch:list-package-detections'),
  clearPackageDetections: () =>
    ipcRenderer.invoke('ringwatch:clear-package-detections'),
  testAiConnection: () => ipcRenderer.invoke('ringwatch:test-ai-connection'),
  testPackageAlert: () => ipcRenderer.invoke('ringwatch:test-package-alert'),

  simulateDemoEvent: (kind) =>
    ipcRenderer.invoke('ringwatch:simulate-demo-event', kind),

  updateSettings: (patch: AppSettingsPatch) =>
    ipcRenderer.invoke('ringwatch:update-settings', patch),
  chooseRecordingsFolder: () =>
    ipcRenderer.invoke('ringwatch:choose-recordings-folder'),

  onConnectionChanged: (cb: (status: ConnectionStatus) => void) =>
    subscribe('ringwatch:connection-changed', cb),
  onCamerasUpdated: (cb: (cameras: RingCameraInfo[]) => void) =>
    subscribe('ringwatch:cameras-updated', cb),
  onSensorsUpdated: (cb: (sensors: RingSensorInfo[]) => void) =>
    subscribe('ringwatch:sensors-updated', cb),
  onLocationsUpdated: (cb: (locations: RingLocationInfo[]) => void) =>
    subscribe('ringwatch:locations-updated', cb),
  onSecurityEvent: (cb: (event: SecurityEvent) => void) =>
    subscribe('ringwatch:security-event', cb),
  onRecordingsUpdated: (cb: (recordings: LocalRecordingItem[]) => void) =>
    subscribe('ringwatch:recordings-updated', cb),
  onStorageStatsUpdated: (cb: (stats: StorageStats) => void) =>
    subscribe('ringwatch:storage-stats-updated', cb),
  onPackageDetection: (cb: (record: PackageDetectionRecord) => void) =>
    subscribe('ringwatch:package-detection', cb),
  onPlayAlertSound: (cb: (payload: AlertSoundPayload) => void) =>
    subscribe('ringwatch:play-alert-sound', cb),
  onFocusCamera: (cb: (cameraId: string) => void) =>
    subscribe('ringwatch:focus-camera', cb),
}

contextBridge.exposeInMainWorld('ringWatch', api)
