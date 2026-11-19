import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  safeStorage,
  shell,
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type {
  AppMode,
  AppSettingsPatch,
  LocalRecordingItem,
  PackageDetectionRecord,
  RingWatchBootstrap,
} from '../shared/types'
import { ConfigStore } from './services/configStore'
import { NotificationService } from './services/notificationService'
import { StreamService } from './services/streamService'
import { RecordingService } from './services/recordingService'
import { AiPackageService } from './services/aiPackageService'
import { RingService } from './services/ringService'

// Ensure Windows 10/11 desktop notifications display RingWatch branding
if (process.platform === 'win32') {
  app.setAppUserModelId('com.ringwatch.desktop')
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let powerSaveBlockerId: number | null = null

let configStore: ConfigStore
let streamService: StreamService
let recordingService: RecordingService
let notificationService: NotificationService
let aiPackageService: AiPackageService
let ringService: RingService

function resolveProjectRoot(): string {
  // Compiled file lives at dist-electron/electron/main.js
  return path.resolve(__dirname, '..', '..')
}

function resolveIconPath(): string {
  const root = resolveProjectRoot()
  const candidates = [
    path.join(root, 'build', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'icon.png'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}

function resolveDemoAssetsDir(): string {
  const root = resolveProjectRoot()
  const distDemo = path.join(root, 'dist', 'demo')
  if (fs.existsSync(distDemo)) return distDemo
  return path.join(root, 'public', 'demo')
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function setPowerSaveBlock(shouldBlock: boolean): void {
  if (shouldBlock) {
    if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
  } else if (powerSaveBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId)
    }
    powerSaveBlockerId = null
  }
}

function syncLoginItemSettings(): void {
  if (!app.isPackaged) return
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  try {
    const settings = configStore.getPublicSettings()
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      args: ['--minimized'],
    })
  } catch {
    // Ignore login item errors in restricted environments
  }
}

function createTray(): void {
  const iconPath = resolveIconPath()
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('RingWatch — 24/7 NVR & AI Package Monitor')
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  rebuildTrayMenu()
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const aiEnabled = configStore.getPublicSettings().packageAi.enabled
  const nvr = ringService?.getNvrStatus()
  const nvrActive = nvr?.active ?? false
  const stats = recordingService?.getStorageStats()
  const freeGb =
    stats?.freeDiskBytes !== null && stats?.freeDiskBytes !== undefined
      ? `${(stats.freeDiskBytes / (1024 * 1024 * 1024)).toFixed(1)} GB free`
      : ''

  if (nvrActive) {
    const totalCams = ringService?.getCameras().length ?? nvr?.activeCameraCount ?? 0
    const failoverTag = stats?.usingFailover ? ' [FAILOVER]' : ''
    tray.setToolTip(
      `RingWatch 24/7 NVR — ${nvr?.activeCameraCount ?? 0}/${totalCams} cams${freeGb ? ` · ${freeGb}` : ''}${failoverTag}`,
    )
  } else {
    tray.setToolTip(
      `RingWatch NVR (Idle)${freeGb ? ` · ${freeGb}` : ''}`,
    )
  }

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open RingWatch',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: nvrActive ? 'Stop 24/7 NVR Recording' : 'Start 24/7 NVR Recording',
      click: () => {
        if (nvrActive) {
          void ringService.stopAllCameraRecording().finally(() => rebuildTrayMenu())
        } else {
          void ringService.startAllCameraRecording().finally(() => rebuildTrayMenu())
        }
      },
    },
    {
      label: aiEnabled ? 'Pause AI Package Detection' : 'Resume AI Package Detection',
      click: () => {
        configStore.updateSettings({ packageAi: { enabled: !aiEnabled } })
        aiPackageService.syncScheduler()
        rebuildTrayMenu()
      },
    },
    {
      label: 'Test Package Alert',
      click: () => {
        aiPackageService.sendTestAlert()
      },
    },
    { type: 'separator' },
    {
      label: 'Quit RingWatch',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

function createMainWindow(): void {
  const iconPath = resolveIconPath()
  const settings = configStore.getPublicSettings()
  const launchedMinimized =
    settings.startMinimized || process.argv.includes('--minimized')

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1020,
    minHeight: 680,
    title: 'RingWatch — 24/7 NVR, Cameras, Sensors & AI Package Hub',
    backgroundColor: '#0b0e13',
    autoHideMenuBar: true,
    show: !launchedMinimized,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on('close', (event) => {
    const minimize = configStore.getPublicSettings().minimizeToTray
    if (!isQuitting && minimize) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const isDev = process.env.NODE_ENV === 'development'
  if (isDev) {
    void mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    const indexHtml = path.join(resolveProjectRoot(), 'dist', 'index.html')
    void mainWindow.loadFile(indexHtml)
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('ringwatch:get-bootstrap', (): RingWatchBootstrap => ({
    connection: ringService.getConnection(),
    settings: configStore.getPublicSettings(),
    storageStats: recordingService.getStorageStats(),
    nvrStatus: ringService.getNvrStatus(),
    locations: ringService.getLocations(),
    cameras: ringService.getCameras(),
    sensors: ringService.getSensors(),
    events: ringService.getEvents(),
    recordings: recordingService.listRecordings(),
    packageDetections: aiPackageService.listDetections(),
    activeStreams: streamService.listActiveSessions(),
  }))

  ipcMain.handle('ringwatch:connect-token', (_e, refreshToken: string) =>
    ringService.connectWithToken(refreshToken),
  )

  ipcMain.handle(
    'ringwatch:login-credentials',
    (_e, params: { email: string; password: string; twoFactorCode?: string }) =>
      ringService.loginWithCredentials(params),
  )

  ipcMain.handle('ringwatch:disconnect', () => ringService.disconnectRing())

  ipcMain.handle('ringwatch:switch-mode', (_e, mode: AppMode) =>
    ringService.switchMode(mode),
  )

  ipcMain.handle('ringwatch:refresh-devices', () => ringService.refreshDevices())

  ipcMain.handle('ringwatch:start-stream', (_e, cameraId: string) =>
    ringService.startLiveStream(cameraId),
  )

  ipcMain.handle('ringwatch:stop-stream', (_e, cameraId: string) => {
    ringService.stopLiveStream(cameraId)
  })

  ipcMain.handle('ringwatch:capture-snapshot', (_e, cameraId: string) =>
    ringService.captureSnapshot(cameraId),
  )

  ipcMain.handle(
    'ringwatch:toggle-light',
    (_e, params: { cameraId: string; on: boolean }) =>
      ringService.toggleCameraLight(params.cameraId, params.on),
  )

  ipcMain.handle(
    'ringwatch:toggle-siren',
    (_e, params: { cameraId: string; on: boolean }) =>
      ringService.toggleCameraSiren(params.cameraId, params.on),
  )

  ipcMain.handle(
    'ringwatch:set-alarm-mode',
    (_e, params: { locationId: string; mode: 'none' | 'some' | 'all' }) =>
      ringService.setAlarmMode(params.locationId, params.mode),
  )

  ipcMain.handle('ringwatch:get-nvr-status', () => ringService.getNvrStatus())

  ipcMain.handle('ringwatch:start-all-recording', (_e, cameraIds?: string[]) =>
    ringService.startAllCameraRecording(cameraIds),
  )

  ipcMain.handle('ringwatch:stop-all-recording', () =>
    ringService.stopAllCameraRecording(),
  )

  ipcMain.handle(
    'ringwatch:toggle-camera-continuous',
    (_e, params: { cameraId: string; enable: boolean }) =>
      ringService.toggleCameraContinuousRecording(params.cameraId, params.enable),
  )

  ipcMain.handle('ringwatch:sync-cloud-events', () =>
    ringService.syncCloudEventsToTimeline(),
  )

  ipcMain.handle(
    'ringwatch:capture-recording',
    (
      _e,
      params: {
        cameraId: string
        durationSeconds: number
        trigger?: LocalRecordingItem['trigger']
      },
    ) => ringService.captureRecording(params),
  )

  ipcMain.handle('ringwatch:list-recordings', () =>
    recordingService.listRecordings(),
  )

  ipcMain.handle('ringwatch:delete-recording', (_e, recordingId: string) => {
    recordingService.deleteRecording(recordingId)
    sendToRenderer('ringwatch:recordings-updated', recordingService.listRecordings())
    sendToRenderer('ringwatch:storage-stats-updated', recordingService.getStorageStats())
  })

  ipcMain.handle('ringwatch:toggle-recording-star', (_e, recordingId: string) => {
    const updated = recordingService.toggleStar(recordingId)
    sendToRenderer('ringwatch:recordings-updated', recordingService.listRecordings())
    sendToRenderer('ringwatch:storage-stats-updated', recordingService.getStorageStats())
    return updated
  })

  ipcMain.handle('ringwatch:export-recording', async (_e, recordingId: string) => {
    if (!mainWindow) return null
    const rec = recordingService.getRecordingById(recordingId)
    if (!rec) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export MP4 Recording',
      defaultPath: rec.fileName,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    })
    if (result.canceled || !result.filePath) return null
    return recordingService.exportRecording(recordingId, result.filePath)
  })

  ipcMain.handle('ringwatch:export-evidence-bundle', async (_e, recordingId: string) => {
    if (!mainWindow) return null
    const rec = recordingService.getRecordingById(recordingId)
    if (!rec) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Evidence Bundle (MP4 + SHA-256 Manifest)',
      defaultPath: rec.fileName,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    })
    if (result.canceled || !result.filePath) return null
    return recordingService.exportEvidenceBundle(recordingId, result.filePath)
  })

  ipcMain.handle('ringwatch:import-videos', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Local MP4 Videos into RingWatch Vault',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'MP4 Videos', extensions: ['mp4'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const imported = recordingService.importVideoFiles(result.filePaths)
    sendToRenderer('ringwatch:recordings-updated', recordingService.listRecordings())
    sendToRenderer('ringwatch:storage-stats-updated', recordingService.getStorageStats())
    return imported
  })

  ipcMain.handle('ringwatch:get-storage-stats', () =>
    recordingService.getStorageStats(),
  )

  ipcMain.handle('ringwatch:list-storage-drives', () =>
    recordingService.listStorageDrives(),
  )

  ipcMain.handle('ringwatch:set-primary-drive', (_e, drivePath: string) => {
    const targetDir = path.join(drivePath, 'RingWatch-NVR')
    fs.mkdirSync(targetDir, { recursive: true })
    const settings = configStore.updateSettings({ recordingsDir: targetDir })
    const res = recordingService.rescanDirectory()
    ringService.syncNvrSettings()
    sendToRenderer('ringwatch:settings-updated', settings)
    sendToRenderer('ringwatch:recordings-updated', res.recordings)
    sendToRenderer('ringwatch:storage-stats-updated', res.stats)
    rebuildTrayMenu()
    return { settings, stats: res.stats }
  })

  ipcMain.handle('ringwatch:set-failover-drive', (_e, drivePath: string) => {
    const targetDir = path.join(drivePath, 'RingWatch-Failover')
    fs.mkdirSync(targetDir, { recursive: true })
    const settings = configStore.updateSettings({ failoverRecordingsDir: targetDir })
    const res = recordingService.rescanDirectory()
    ringService.syncNvrSettings()
    sendToRenderer('ringwatch:settings-updated', settings)
    sendToRenderer('ringwatch:recordings-updated', res.recordings)
    sendToRenderer('ringwatch:storage-stats-updated', res.stats)
    return { settings, stats: res.stats }
  })

  ipcMain.handle('ringwatch:clear-failover-storage', () => {
    const settings = configStore.updateSettings({ failoverRecordingsDir: '' })
    const stats = recordingService.getStorageStats()
    ringService.syncNvrSettings()
    sendToRenderer('ringwatch:settings-updated', settings)
    sendToRenderer('ringwatch:storage-stats-updated', stats)
    return { settings, stats }
  })

  ipcMain.handle('ringwatch:rescan-storage', () => {
    const res = recordingService.rescanDirectory()
    sendToRenderer('ringwatch:recordings-updated', res.recordings)
    sendToRenderer('ringwatch:storage-stats-updated', res.stats)
    return res
  })

  ipcMain.handle('ringwatch:prune-storage', () => {
    const res = recordingService.enforceRetentionAndQuota()
    sendToRenderer('ringwatch:recordings-updated', recordingService.listRecordings())
    sendToRenderer('ringwatch:storage-stats-updated', res.stats)
    return res
  })

  ipcMain.handle('ringwatch:open-recording-folder', (_e, recordingId: string) => {
    const rec = recordingService.getRecordingById(recordingId)
    if (rec && fs.existsSync(rec.filePath)) {
      shell.showItemInFolder(rec.filePath)
    } else {
      const dir = recordingService.resolveActiveStorageDir().activeDir
      fs.mkdirSync(dir, { recursive: true })
      void shell.openPath(dir)
    }
  })

  ipcMain.handle('ringwatch:open-recordings-root', () => {
    const dir = recordingService.resolveActiveStorageDir().activeDir
    fs.mkdirSync(dir, { recursive: true })
    void shell.openPath(dir)
  })

  ipcMain.handle('ringwatch:list-cloud-recordings', (_e, cameraId: string) =>
    ringService.listCloudRecordings(cameraId),
  )

  ipcMain.handle(
    'ringwatch:download-cloud-recording',
    (_e, params: { cameraId: string; dingId: string }) =>
      ringService.downloadCloudRecording(params.cameraId, params.dingId),
  )

  ipcMain.handle(
    'ringwatch:scan-packages',
    (
      _e,
      params: { cameraId: string; trigger?: PackageDetectionRecord['trigger'] },
    ) => aiPackageService.scanCamera(params.cameraId, params.trigger ?? 'manual'),
  )

  ipcMain.handle('ringwatch:list-package-detections', () =>
    aiPackageService.listDetections(),
  )

  ipcMain.handle('ringwatch:clear-package-detections', () => {
    aiPackageService.clearDetections()
  })

  ipcMain.handle('ringwatch:test-ai-connection', () =>
    aiPackageService.testConnection(),
  )

  ipcMain.handle('ringwatch:test-package-alert', () => {
    aiPackageService.sendTestAlert()
  })

  ipcMain.handle(
    'ringwatch:simulate-demo-event',
    (_e, kind: 'doorbell' | 'motion' | 'contact-open' | 'package-delivery') =>
      ringService.simulateDemoEvent(kind),
  )

  ipcMain.handle('ringwatch:update-settings', (_e, patch: AppSettingsPatch) => {
    const updated = configStore.updateSettings(patch)
    aiPackageService.syncScheduler()
    syncLoginItemSettings()
    ringService.syncNvrSettings()
    rebuildTrayMenu()
    sendToRenderer('ringwatch:settings-updated', updated)
    sendToRenderer('ringwatch:storage-stats-updated', recordingService.getStorageStats())
    return updated
  })

  ipcMain.handle('ringwatch:choose-recordings-folder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Primary NVR Recordings Folder (Internal, USB, or NAS)',
      defaultPath: configStore.getPublicSettings().recordingsDir,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    const updated = configStore.updateSettings({ recordingsDir: chosen })
    const res = recordingService.rescanDirectory()
    ringService.syncNvrSettings()
    sendToRenderer('ringwatch:settings-updated', updated)
    sendToRenderer('ringwatch:recordings-updated', res.recordings)
    sendToRenderer('ringwatch:storage-stats-updated', res.stats)
    rebuildTrayMenu()
    return chosen
  })

  ipcMain.handle('ringwatch:choose-failover-folder', async () => {
    if (!mainWindow) return null
    const current = configStore.getPublicSettings().failoverRecordingsDir
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Failover NVR Storage Folder',
      defaultPath: current || configStore.getDefaultRecordingsDir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    const updated = configStore.updateSettings({ failoverRecordingsDir: chosen })
    const res = recordingService.rescanDirectory()
    ringService.syncNvrSettings()
    sendToRenderer('ringwatch:settings-updated', updated)
    sendToRenderer('ringwatch:recordings-updated', res.recordings)
    sendToRenderer('ringwatch:storage-stats-updated', res.stats)
    return chosen
  })
}

const singleInstanceLock = app.requestSingleInstanceLock()

if (!singleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    const userDataDir = app.getPath('userData')
    const defaultRecordingsDir = path.join(app.getPath('videos'), 'RingWatch')
    fs.mkdirSync(defaultRecordingsDir, { recursive: true })

    configStore = new ConfigStore(userDataDir, defaultRecordingsDir, safeStorage)
    syncLoginItemSettings()

    streamService = new StreamService(
      () => configStore.getPublicSettings().recordingsDir,
      () => (recordingService ? recordingService.getAllStorageRoots() : []),
    )
    recordingService = new RecordingService(
      userDataDir,
      configStore,
      streamService,
    )
    recordingService.rescanDirectory()
    recordingService.enforceRetentionAndQuota()

    notificationService = new NotificationService(
      resolveIconPath(),
      () => mainWindow,
    )
    aiPackageService = new AiPackageService({
      userDataDir,
      configStore,
      notifications: notificationService,
      onDetection: (record) => {
        sendToRenderer('ringwatch:package-detection', record)
        if (record.packageDetected && record.notified) {
          void ringService?.autoCaptureIfEnabled(record.cameraId, 'package')
        }
      },
      onSecurityEvent: (event) => {
        if (ringService) {
          ringService.recordExternalEvent(event)
        } else {
          sendToRenderer('ringwatch:security-event', event)
        }
      },
    })

    ringService = new RingService({
      userDataDir,
      configStore,
      streamService,
      recordingService,
      aiPackageService,
      notifications: notificationService,
      onPowerSaveChange: (shouldBlock) => setPowerSaveBlock(shouldBlock),
      demoAssetsDir: resolveDemoAssetsDir(),
      callbacks: {
        onConnectionChanged: (status) =>
          sendToRenderer('ringwatch:connection-changed', status),
        onSettingsUpdated: (settings) =>
          sendToRenderer('ringwatch:settings-updated', settings),
        onCamerasUpdated: (cameras) =>
          sendToRenderer('ringwatch:cameras-updated', cameras),
        onSensorsUpdated: (sensors) =>
          sendToRenderer('ringwatch:sensors-updated', sensors),
        onLocationsUpdated: (locations) =>
          sendToRenderer('ringwatch:locations-updated', locations),
        onSecurityEvent: (event) =>
          sendToRenderer('ringwatch:security-event', event),
        onEventsUpdated: (events) =>
          sendToRenderer('ringwatch:events-updated', events),
        onNvrStatusUpdated: (status) => {
          sendToRenderer('ringwatch:nvr-status-updated', status)
          rebuildTrayMenu()
        },
        onRecordingsUpdated: (recordings) =>
          sendToRenderer('ringwatch:recordings-updated', recordings),
        onStorageStatsUpdated: (stats) => {
          sendToRenderer('ringwatch:storage-stats-updated', stats)
          rebuildTrayMenu()
        },
      },
    })

    registerIpcHandlers()
    await ringService.initialize()
    createMainWindow()
    createTray()
  })

  app.on('before-quit', () => {
    isQuitting = true
    setPowerSaveBlock(false)
    ringService?.shutdown()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
