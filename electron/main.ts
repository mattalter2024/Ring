import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
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

function createTray(): void {
  const iconPath = resolveIconPath()
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('RingWatch — Ring Cameras & AI Package Monitor')
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

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1020,
    minHeight: 680,
    title: 'RingWatch — Ring Cameras, Sensors & AI Package Hub',
    backgroundColor: '#0b0e13',
    autoHideMenuBar: true,
    show: !settings.startMinimized,
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
      const dir = configStore.getPublicSettings().recordingsDir
      fs.mkdirSync(dir, { recursive: true })
      void shell.openPath(dir)
    }
  })

  ipcMain.handle('ringwatch:open-recordings-root', () => {
    const dir = configStore.getPublicSettings().recordingsDir
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
    rebuildTrayMenu()
    sendToRenderer('ringwatch:storage-stats-updated', recordingService.getStorageStats())
    return updated
  })

  ipcMain.handle('ringwatch:choose-recordings-folder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select RingWatch Recordings Folder',
      defaultPath: configStore.getPublicSettings().recordingsDir,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    configStore.updateSettings({ recordingsDir: chosen })
    const res = recordingService.rescanDirectory()
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
    streamService = new StreamService(
      () => configStore.getPublicSettings().recordingsDir,
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
      onSecurityEvent: (event) =>
        sendToRenderer('ringwatch:security-event', event),
    })

    ringService = new RingService({
      configStore,
      streamService,
      recordingService,
      aiPackageService,
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
        onRecordingsUpdated: (recordings) =>
          sendToRenderer('ringwatch:recordings-updated', recordings),
        onStorageStatsUpdated: (stats) =>
          sendToRenderer('ringwatch:storage-stats-updated', stats),
      },
    })

    registerIpcHandlers()
    await ringService.initialize()
    createMainWindow()
    createTray()
  })

  app.on('before-quit', () => {
    isQuitting = true
    ringService?.shutdown()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
