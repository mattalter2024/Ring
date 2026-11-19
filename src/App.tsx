import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppMode,
  AppSettingsPatch,
  CloudRecordingItem,
  PackageDetectionRecord,
  RingAuthStepResult,
  StorageDriveInfo,
} from '@shared/types'
import { useRingWatch } from '@/hooks/useRingWatch'
import { Sidebar, type NavTab } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { CamerasView } from '@/components/CamerasView'
import { NvrView } from '@/components/NvrView'
import { TimelineView } from '@/components/TimelineView'
import { RecordingsView } from '@/components/RecordingsView'
import { SensorsView } from '@/components/SensorsView'
import { PackageAiView } from '@/components/PackageAiView'
import { SettingsView } from '@/components/SettingsView'
import { playAlertChime } from '@/utils/audioChime'
import { formatBytes } from '@/utils/format'

export function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('cameras')
  const [focusedCameraId, setFocusedCameraId] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [nvrBusy, setNvrBusy] = useState(false)
  const [autoLiveEnabled, setAutoLiveEnabled] = useState(true)
  const [connectingCameraIds, setConnectingCameraIds] = useState<Record<string, boolean>>({})

  const [autoLiveTick, setAutoLiveTick] = useState(0)
  const connectingRef = useRef<Set<string>>(new Set())
  const manuallyStoppedRef = useRef<Set<string>>(new Set())
  const lastAutoFailRef = useRef<Record<string, number>>({})
  const failCountRef = useRef<Record<string, number>>({})
  const lastStallRestartRef = useRef<Record<string, number>>({})

  const handleFocusFromNotification = useCallback((cameraId: string) => {
    setActiveTab('cameras')
    setFocusedCameraId(cameraId)
  }, [])

  const {
    api,
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
  } = useRingWatch(handleFocusFromNotification)

  const handleRefresh = async () => {
    if (!api) {
      pushToast('Synced', 'Demo devices are up to date.', 'ok')
      return
    }
    setIsRefreshing(true)
    try {
      const res = await api.refreshDevices()
      setLocations(res.locations)
      setCameras(res.cameras)
      setSensors(res.sensors)
      pushToast('Devices Synced', `Loaded ${res.cameras.length} camera(s) and ${res.sensors.length} sensor(s).`, 'ok')
    } catch (err) {
      pushToast('Sync Failed', err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setIsRefreshing(false)
    }
  }

  const startStreamInternal = useCallback(
    async (cameraId: string, silent = false) => {
      if (connectingRef.current.has(cameraId)) return
      manuallyStoppedRef.current.delete(cameraId)

      if (!api) {
        setStreamsByCamera((prev) => ({
          ...prev,
          [cameraId]: {
            cameraId,
            mode: 'demo',
            streamUrl: `demo://${cameraId}`,
            startedAt: new Date().toISOString(),
            audioEnabled: false,
          },
        }))
        return
      }

      connectingRef.current.add(cameraId)
      setConnectingCameraIds((prev) => ({ ...prev, [cameraId]: true }))
      try {
        const session = await api.startLiveStream(cameraId)
        delete lastAutoFailRef.current[cameraId]
        delete failCountRef.current[cameraId]
        setStreamsByCamera((prev) => ({ ...prev, [cameraId]: session }))
      } catch (err) {
        lastAutoFailRef.current[cameraId] = Date.now()
        failCountRef.current[cameraId] = (failCountRef.current[cameraId] ?? 0) + 1
        if (!silent) {
          pushToast('Stream Failed', err instanceof Error ? err.message : String(err), 'err')
        }
      } finally {
        connectingRef.current.delete(cameraId)
        setConnectingCameraIds((prev) => {
          const next = { ...prev }
          delete next[cameraId]
          return next
        })
      }
    },
    [api, pushToast, setStreamsByCamera],
  )

  const handleStartStream = useCallback(
    async (cameraId: string) => {
      delete failCountRef.current[cameraId]
      delete lastAutoFailRef.current[cameraId]
      await startStreamInternal(cameraId, false)
    },
    [startStreamInternal],
  )

  const handleStopStream = useCallback(
    async (cameraId: string) => {
      manuallyStoppedRef.current.add(cameraId)
      if (api) {
        await api.stopLiveStream(cameraId)
      }
      setStreamsByCamera((prev) => {
        const next = { ...prev }
        delete next[cameraId]
        return next
      })
    },
    [api, setStreamsByCamera],
  )

  const handleStreamStalled = useCallback(
    (cameraId: string) => {
      if (!api || manuallyStoppedRef.current.has(cameraId)) return
      const now = Date.now()
      if (now - (lastStallRestartRef.current[cameraId] ?? 0) < 20_000) return
      lastStallRestartRef.current[cameraId] = now
      void (async () => {
        try {
          await api.stopLiveStream(cameraId)
        } catch {
          // ignore
        }
        delete lastAutoFailRef.current[cameraId]
        delete failCountRef.current[cameraId]
        await startStreamInternal(cameraId, true)
      })()
    },
    [api, startStreamInternal],
  )

  const handleStartAllLive = useCallback(async () => {
    manuallyStoppedRef.current.clear()
    lastAutoFailRef.current = {}
    failCountRef.current = {}
    setAutoLiveEnabled(true)
    const targets = cameras.filter((c) => c.online && !streamsByCamera[c.id])
    await Promise.allSettled(targets.map((cam) => startStreamInternal(cam.id, true)))
  }, [cameras, streamsByCamera, startStreamInternal])

  const handleStopAllLive = useCallback(async () => {
    setAutoLiveEnabled(false)
    for (const cam of cameras) {
      manuallyStoppedRef.current.add(cam.id)
    }
    await Promise.allSettled(
      Object.keys(streamsByCamera).map((id) =>
        api ? api.stopLiveStream(id) : Promise.resolve(),
      ),
    )
    setStreamsByCamera({})
  }, [api, cameras, streamsByCamera, setStreamsByCamera])

  const handleSelectFocusCamera = useCallback(
    (cameraId: string | null) => {
      setFocusedCameraId(cameraId)
      if (cameraId && !streamsByCamera[cameraId]) {
        void startStreamInternal(cameraId, false)
      }
    },
    [streamsByCamera, startStreamInternal],
  )

  // Periodic 5-second watchdog so any camera whose live stream dropped or failed retries automatically
  useEffect(() => {
    if (loading || activeTab !== 'cameras' || !autoLiveEnabled) return
    const timer = setInterval(() => {
      setAutoLiveTick((t) => t + 1)
    }, 5000)
    return () => clearInterval(timer)
  }, [loading, activeTab, autoLiveEnabled])

  // Automatically keep all online cameras streaming live when viewing the Live Cameras tab
  useEffect(() => {
    if (loading || activeTab !== 'cameras' || !autoLiveEnabled || cameras.length === 0) {
      return
    }

    const now = Date.now()
    const eligible = cameras.filter((cam) => {
      if (!cam.online) return false
      if (streamsByCamera[cam.id]) return false
      if (connectingRef.current.has(cam.id)) return false
      if (manuallyStoppedRef.current.has(cam.id)) return false
      const nvrRecording = nvrStatus.cameras[cam.id]?.state === 'recording'
      const lastFail = lastAutoFailRef.current[cam.id] ?? 0
      const failCount = failCountRef.current[cam.id] ?? 0
      const retryCooldownMs = Math.min(15_000, Math.max(5_000, failCount * 5_000))
      // Attach immediately if NVR already has a live feed; otherwise retry after short backoff
      if (!nvrRecording && lastFail > 0 && now - lastFail < retryCooldownMs) return false
      return true
    })

    if (eligible.length === 0) return

    const timers: Array<ReturnType<typeof setTimeout>> = []
    eligible.forEach((cam, idx) => {
      const nvrRecording = nvrStatus.cameras[cam.id]?.state === 'recording'
      const delayMs = connection.mode === 'demo' || nvrRecording ? 0 : idx * 250
      if (delayMs === 0) {
        void startStreamInternal(cam.id, true)
      } else {
        timers.push(
          setTimeout(() => {
            void startStreamInternal(cam.id, true)
          }, delayMs),
        )
      }
    })

    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [
    loading,
    activeTab,
    autoLiveEnabled,
    autoLiveTick,
    cameras,
    streamsByCamera,
    nvrStatus.cameras,
    connection.mode,
    startStreamInternal,
  ])

  const handleCaptureRecording = async (
    cameraId: string,
    durationSeconds: number,
  ) => {
    if (!api) {
      pushToast(
        'Desktop App Required',
        'MP4 file capture runs in the Electron Windows desktop process.',
        'warn',
      )
      return
    }
    try {
      const rec = await api.captureRecording({
        cameraId,
        durationSeconds,
        trigger: 'manual',
      })
      pushToast(
        'Recording Saved',
        `Saved ${rec.fileName} to your local Recordings Vault.`,
        'ok',
      )
    } catch (err) {
      pushToast(
        'Recording Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleToggleStar = async (recordingId: string) => {
    if (!api) {
      setRecordings((prev) =>
        prev.map((r) => (r.id === recordingId ? { ...r, starred: !r.starred } : r)),
      )
      return
    }
    const updated = await api.toggleRecordingStar(recordingId)
    pushToast(
      updated.starred ? 'Clip Protected' : 'Protection Removed',
      updated.starred
        ? `${updated.fileName} is locked and exempt from auto-pruning.`
        : `${updated.fileName} can now be pruned by retention rules.`,
      'info',
    )
  }

  const handleExportRecording = async (recordingId: string) => {
    if (!api) return
    const savedPath = await api.exportRecording(recordingId)
    if (savedPath) {
      pushToast('Video Exported', `Saved copy to ${savedPath}`, 'ok')
    }
  }

  const handleImportVideos = async () => {
    if (!api) return
    const imported = await api.importLocalVideos()
    if (imported.length > 0) {
      pushToast(
        'Videos Imported',
        `Imported ${imported.length} MP4 clip(s) into local storage.`,
        'ok',
      )
    }
  }

  const handleRescanStorage = async () => {
    if (!api) return
    const res = await api.rescanLocalStorage()
    pushToast(
      'Disk Folder Rescanned',
      `Indexed ${res.stats.totalClips} local MP4 clip(s) (${formatBytes(res.stats.totalBytes)}).`,
      'ok',
    )
  }

  const handlePruneStorage = async () => {
    if (!api) return
    const res = await api.pruneLocalStorage()
    pushToast(
      'Storage Cleanup Complete',
      res.prunedCount > 0
        ? `Removed ${res.prunedCount} expired/over-quota clip(s), freeing ${formatBytes(res.freedBytes)}.`
        : 'All local clips are within your quota and retention policy.',
      'info',
    )
  }

  const handleCaptureSnapshot = async (cameraId: string) => {
    if (!api) {
      pushToast('Snapshot Refreshed', 'Demo frame updated.', 'ok')
      return
    }
    try {
      await api.captureSnapshot(cameraId)
      pushToast('Snapshot Updated', 'Captured fresh frame from camera.', 'ok')
    } catch (err) {
      pushToast(
        'Snapshot Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleScanPackages = async (cameraId: string) => {
    if (!api) {
      const cam = cameras.find((c) => c.id === cameraId)
      const isFront = cameraId === 'demo-cam-front'
      const record: PackageDetectionRecord = {
        id: `preview-${Date.now()}`,
        cameraId,
        cameraName: cam?.name ?? 'Camera',
        timestamp: new Date().toISOString(),
        provider: 'demo-vision',
        model: 'demo-simulator',
        trigger: 'manual',
        packageDetected: isFront,
        confidence: isFront ? 0.96 : 0.94,
        packageCount: isFront ? 2 : 0,
        carrierHint: isFront ? 'Standard Parcel' : null,
        placement: isFront ? 'On welcome mat beside front door' : null,
        personPresent: false,
        summary: isFront
          ? 'Two cardboard delivery boxes detected on the front door welcome mat.'
          : 'No packages visible in camera frame.',
        snapshotDataUrl: cam?.lastSnapshotDataUrl,
        notified: isFront,
        latencyMs: 320,
      }
      setPackageDetections((prev) => [record, ...prev])
      if (isFront) {
        playAlertChime(settings.packageAi.alertSound, settings.packageAi.alertVolume)
        pushToast(`Package Detected — ${record.cameraName}`, record.summary, 'warn')
      } else {
        pushToast('Porch Clear', record.summary, 'ok')
      }
      return
    }
    try {
      const res = await api.scanCameraForPackages(cameraId, 'manual')
      if (res.rawError) {
        pushToast('AI Scan Error', res.rawError, 'err')
      } else if (!res.notified) {
        pushToast(
          res.packageDetected ? 'Package Detected' : 'No Package Detected',
          res.summary,
          res.packageDetected ? 'warn' : 'ok',
        )
      }
    } catch (err) {
      pushToast(
        'AI Scan Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleToggleLight = async (cameraId: string, on: boolean) => {
    if (!api) {
      setCameras((prev) =>
        prev.map((c) => (c.id === cameraId ? { ...c, lightOn: on } : c)),
      )
      return
    }
    try {
      await api.toggleCameraLight(cameraId, on)
    } catch (err) {
      pushToast('Light Control Failed', err instanceof Error ? err.message : String(err), 'err')
    }
  }

  const handleToggleSiren = async (cameraId: string, on: boolean) => {
    if (!api) {
      setCameras((prev) =>
        prev.map((c) => (c.id === cameraId ? { ...c, sirenOn: on } : c)),
      )
      return
    }
    try {
      await api.toggleCameraSiren(cameraId, on)
    } catch (err) {
      pushToast('Siren Control Failed', err instanceof Error ? err.message : String(err), 'err')
    }
  }

  const handleSetAlarmMode = async (
    locationId: string,
    mode: 'none' | 'some' | 'all',
  ) => {
    if (!api) {
      setLocations((prev) =>
        prev.map((l) => (l.id === locationId ? { ...l, alarmMode: mode } : l)),
      )
      return
    }
    try {
      await api.setAlarmMode(locationId, mode)
    } catch (err) {
      pushToast('Alarm Mode Failed', err instanceof Error ? err.message : String(err), 'err')
    }
  }

  const handleUpdateSettings = async (patch: AppSettingsPatch) => {
    if (!api) {
      setSettings((prev) => ({
        ...prev,
        ...patch,
        packageAi: { ...prev.packageAi, ...(patch.packageAi ?? {}) },
      }))
      return
    }
    const updated = await api.updateSettings(patch)
    setSettings(updated)
  }

  const handleSimulateDemoEvent = async (
    kind: 'doorbell' | 'motion' | 'contact-open' | 'package-delivery',
  ) => {
    if (!api) {
      if (kind === 'package-delivery') {
        await handleScanPackages('demo-cam-front')
      } else if (kind === 'contact-open') {
        setSensors((prev) =>
          prev.map((s) =>
            s.id === 'demo-sensor-front-door'
              ? {
                  ...s,
                  faulted: !s.faulted,
                  statusLabel: !s.faulted ? 'Open' : 'Closed',
                  lastUpdatedAt: new Date().toISOString(),
                }
              : s,
          ),
        )
        pushToast('Sensor Updated', 'Toggled Front Door contact state.', 'warn')
      } else {
        setEvents((prev) => [
          {
            id: `sim-${Date.now()}`,
            timestamp: new Date().toISOString(),
            sourceType: 'camera',
            deviceName: 'Front Porch Doorbell Pro',
            kind: kind === 'doorbell' ? 'ding' : 'motion',
            title: kind === 'doorbell' ? 'Doorbell Ring — Front Porch' : 'Motion Detected',
            detail: 'Simulated event in browser preview.',
            severity: 'warning',
          },
          ...prev,
        ])
        pushToast('Simulated Event', `Triggered ${kind} event.`, 'info')
      }
      return
    }
    await api.simulateDemoEvent(kind)
  }

  const handleListCloudRecordings = async (
    cameraId: string,
  ): Promise<CloudRecordingItem[]> => {
    if (!api) return []
    try {
      return await api.listCloudRecordings(cameraId)
    } catch (err) {
      pushToast(
        'Cloud History Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
      return []
    }
  }

  const handleDownloadCloudRecording = async (
    cameraId: string,
    dingId: string,
  ) => {
    if (!api) return
    try {
      const saved = await api.downloadCloudRecording(cameraId, dingId)
      pushToast('Cloud Clip Saved', `Downloaded ${saved.fileName}`, 'ok')
    } catch (err) {
      pushToast(
        'Download Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleSwitchMode = async (mode: AppMode) => {
    if (!api) {
      setConnection((prev) => ({ ...prev, mode }))
      return
    }
    const status = await api.switchMode(mode)
    setConnection(status)
    setSettings((prev) => ({ ...prev, mode }))
  }

  const handleLoginCredentials = async (params: {
    email: string
    password: string
    twoFactorCode?: string
  }): Promise<RingAuthStepResult> => {
    if (!api) {
      return {
        status: 'error',
        error: 'Ring sign-in runs inside the Electron Windows app.',
      }
    }
    const res = await api.loginWithCredentials(params)
    if (res.connection) {
      setConnection(res.connection)
    }
    if (res.status === 'authenticated' && res.connection?.connected) {
      pushToast(
        'Ring Connected',
        `${res.connection.accountLabel ?? 'Connected to Ring'} · ${res.connection.cameraCount} camera(s), ${res.connection.sensorCount} sensor(s).`,
        'ok',
      )
    } else if (res.status === 'error' && res.error) {
      pushToast('Ring Connection Failed', res.error, 'err')
    }
    return res
  }

  const handleConnectToken = async (token: string) => {
    if (!api) return
    const status = await api.connectWithToken(token)
    setConnection(status)
    if (status.connected) {
      pushToast(
        'Ring Connected',
        `${status.accountLabel ?? 'Connected via token'} · ${status.cameraCount} camera(s), ${status.sensorCount} sensor(s).`,
        'ok',
      )
    } else if (status.error) {
      pushToast('Connection Failed', status.error, 'err')
    }
  }

  const handleDisconnectRing = async () => {
    if (!api) return
    const status = await api.disconnectRing()
    setConnection(status)
    setSettings((prev) => ({ ...prev, mode: 'demo', hasRingToken: false }))
    pushToast('Disconnected', 'Removed Ring token and returned to Demo Mode.', 'info')
  }

  const handleChooseFolder = async () => {
    if (!api) return
    const dir = await api.chooseRecordingsFolder()
    if (dir) {
      setSettings((prev) => ({ ...prev, recordingsDir: dir }))
      pushToast('Primary Storage Updated', `Recordings will save to ${dir}`, 'ok')
    }
  }

  const handleChooseFailoverFolder = async () => {
    if (!api) return
    const dir = await api.chooseFailoverFolder()
    if (dir) {
      setSettings((prev) => ({ ...prev, failoverRecordingsDir: dir }))
      pushToast('Failover Storage Updated', `Failover storage set to ${dir}`, 'ok')
    }
  }

  const handleListStorageDrives = useCallback(async (): Promise<StorageDriveInfo[]> => {
    if (!api) return []
    try {
      return await api.listStorageDrives()
    } catch (err) {
      pushToast(
        'Drive Scan Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
      return []
    }
  }, [api, pushToast])

  const handleSetPrimaryDrive = async (drivePath: string) => {
    if (!api) return
    try {
      const res = await api.setPrimaryStorageDrive(drivePath)
      setSettings(res.settings)
      setStorageStats(res.stats)
      pushToast(
        'Primary NVR Drive Set',
        `24/7 NVR now records to ${res.settings.recordingsDir}`,
        'ok',
      )
    } catch (err) {
      pushToast(
        'Drive Assignment Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleSetFailoverDrive = async (drivePath: string) => {
    if (!api) return
    try {
      const res = await api.setFailoverStorageDrive(drivePath)
      setSettings(res.settings)
      setStorageStats(res.stats)
      pushToast(
        'Failover Drive Set',
        `Failover recording target set to ${res.settings.failoverRecordingsDir}`,
        'ok',
      )
    } catch (err) {
      pushToast(
        'Failover Assignment Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleClearFailover = async () => {
    if (!api) return
    const res = await api.clearFailoverStorage()
    setSettings(res.settings)
    setStorageStats(res.stats)
    pushToast(
      'Failover Cleared',
      'Cleared custom failover drive (built-in Videos\\RingWatch remains emergency fallback).',
      'info',
    )
  }

  const handleExportEvidenceBundle = async (recordingId: string) => {
    if (!api) {
      pushToast(
        'Desktop App Required',
        'SHA-256 Evidence Bundle export runs inside the Electron Windows app.',
        'warn',
      )
      return
    }
    try {
      const bundle = await api.exportEvidenceBundle(recordingId)
      if (bundle) {
        pushToast(
          'Evidence Bundle Exported',
          `Saved MP4 + SHA-256 manifest (${bundle.sha256.slice(0, 12)}…)`,
          'ok',
        )
      }
    } catch (err) {
      pushToast(
        'Evidence Export Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleTestAiConnection = async () => {
    if (!api) {
      return {
        ok: false,
        message: 'Run inside Electron Windows app to test live Vision API.',
      }
    }
    return api.testAiConnection()
  }

  const handleTestAlert = async () => {
    if (!api) {
      playAlertChime(settings.packageAi.alertSound, settings.packageAi.alertVolume)
      pushToast(
        'RingWatch Test Alert — Package Detected',
        'Two cardboard boxes detected on Front Porch welcome mat (96%).',
        'warn',
      )
      return
    }
    await api.testPackageAlert()
  }

  const handleToggleAllRecording = async () => {
    if (!api) {
      pushToast(
        'Desktop App Required',
        'Continuous all-camera MP4 recording runs in the Electron Windows desktop process.',
        'warn',
      )
      return
    }
    setNvrBusy(true)
    try {
      if (nvrStatus.active) {
        const status = await api.stopAllCameraRecording()
        setNvrStatus(status)
        pushToast(
          'Continuous NVR Stopped',
          'Flushed active segments to your Timeline & Local Recordings folder.',
          'info',
        )
      } else {
        const status = await api.startAllCameraRecording()
        setNvrStatus(status)
        const targetCount = Object.values(status.cameras).filter(
          (c) => c.state !== 'stopped',
        ).length
        pushToast(
          'All-Camera NVR Started',
          targetCount > 0
            ? `Recording live streams across ${targetCount} camera(s) in ${settings.continuousSegmentSeconds}s Timeline segments.`
            : 'No eligible cameras found to record. Check Settings -> Continuous NVR.',
          targetCount > 0 ? 'ok' : 'warn',
        )
      }
    } catch (err) {
      pushToast(
        'NVR Recording Error',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    } finally {
      setNvrBusy(false)
    }
  }

  const handleToggleCameraContinuous = async (
    cameraId: string,
    enable: boolean,
  ) => {
    if (!api) {
      pushToast(
        'Desktop App Required',
        'Continuous MP4 recording runs in the Electron Windows desktop process.',
        'warn',
      )
      return
    }
    const cam = cameras.find((c) => c.id === cameraId)
    try {
      const status = await api.toggleCameraContinuousRecording(cameraId, enable)
      setNvrStatus(status)
      pushToast(
        enable ? 'Camera NVR Started' : 'Camera NVR Stopped',
        enable
          ? `Continuously recording ${cam?.name ?? 'camera'} to your Timeline.`
          : `Stopped continuous recording for ${cam?.name ?? 'camera'}.`,
        enable ? 'ok' : 'info',
      )
    } catch (err) {
      pushToast(
        'Camera NVR Error',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleSyncCloudEvents = async () => {
    if (!api) {
      pushToast('Demo Mode', 'Simulated events are already shown on the Timeline.', 'info')
      return
    }
    try {
      const res = await api.syncCloudEventsToTimeline()
      setEvents(res.events)
      pushToast(
        'Ring Events Synced',
        res.addedCount > 0
          ? `Added ${res.addedCount} Ring Cloud motion/doorbell event(s) to your Timeline (${res.events.length} total).`
          : `Timeline events are up to date (${res.events.length} total events).`,
        'ok',
      )
    } catch (err) {
      pushToast(
        'Event Sync Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const faultedSensorCount = sensors.filter((s) => s.faulted).length
  const detectedPackagesCount = packageDetections.filter(
    (d) => d.packageDetected,
  ).length

  return (
    <div className="app-shell">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        connection={connection}
        nvrStatus={nvrStatus}
        storageStats={storageStats}
        streamingCount={Object.keys(streamsByCamera).length}
        recordingsCount={recordings.length}
        faultedSensorCount={faultedSensorCount}
        detectedPackagesCount={detectedPackagesCount}
      />

      <div className="workspace-column">
        <TopBar
          activeTab={activeTab}
          connection={connection}
          primaryLocation={locations[0]}
          nvrStatus={nvrStatus}
          storageStats={storageStats}
          cameraCount={cameras.length}
          nvrBusy={nvrBusy}
          isRefreshing={isRefreshing}
          onToggleAllRecording={() => void handleToggleAllRecording()}
          onOpenNvr={() => setActiveTab('nvr')}
          onRefresh={() => void handleRefresh()}
          onSimulateDemoEvent={(kind) => void handleSimulateDemoEvent(kind)}
        />

        <main className="main-scroll">
          {loading ? (
            <div className="empty-state">
              <span>Initializing RingWatch services…</span>
            </div>
          ) : activeTab === 'cameras' ? (
            <CamerasView
              cameras={cameras}
              streamsByCamera={streamsByCamera}
              connectingCameraIds={connectingCameraIds}
              autoLiveEnabled={autoLiveEnabled}
              nvrStatus={nvrStatus}
              nvrBusy={nvrBusy}
              recordingsCount={recordings.length}
              packageDetections={packageDetections}
              defaultCaptureSeconds={settings.defaultCaptureSeconds}
              focusedCameraId={focusedCameraId}
              onSelectFocusCamera={handleSelectFocusCamera}
              onToggleAutoLive={(enabled) => {
                setAutoLiveEnabled(enabled)
                if (enabled) {
                  manuallyStoppedRef.current.clear()
                  lastAutoFailRef.current = {}
                  failCountRef.current = {}
                }
              }}
              onStartAllLive={handleStartAllLive}
              onStopAllLive={handleStopAllLive}
              onStartStream={handleStartStream}
              onStopStream={handleStopStream}
              onStreamStalled={handleStreamStalled}
              onCaptureRecording={handleCaptureRecording}
              onToggleAllRecording={handleToggleAllRecording}
              onToggleCameraContinuous={handleToggleCameraContinuous}
              onOpenTimeline={() => setActiveTab('timeline')}
              onCaptureSnapshot={handleCaptureSnapshot}
              onScanPackages={handleScanPackages}
              onToggleLight={handleToggleLight}
              onToggleSiren={handleToggleSiren}
            />
          ) : activeTab === 'nvr' ? (
            <NvrView
              cameras={cameras}
              settings={settings}
              nvrStatus={nvrStatus}
              storageStats={storageStats}
              events={events}
              nvrBusy={nvrBusy}
              onToggleAllRecording={handleToggleAllRecording}
              onToggleCameraContinuous={handleToggleCameraContinuous}
              onUpdateSettings={handleUpdateSettings}
              onListStorageDrives={handleListStorageDrives}
              onSetPrimaryDrive={handleSetPrimaryDrive}
              onSetFailoverDrive={handleSetFailoverDrive}
              onClearFailover={handleClearFailover}
              onChoosePrimaryFolder={handleChooseFolder}
              onChooseFailoverFolder={handleChooseFailoverFolder}
              onRescanStorage={handleRescanStorage}
              onPruneStorage={handlePruneStorage}
              onOpenRootFolder={async () => {
                if (api) await api.openRecordingsRootFolder()
              }}
            />
          ) : activeTab === 'timeline' ? (
            <TimelineView
              cameras={cameras}
              recordings={recordings}
              events={events}
              packageDetections={packageDetections}
              nvrStatus={nvrStatus}
              nvrBusy={nvrBusy}
              defaultCaptureSeconds={settings.defaultCaptureSeconds}
              onToggleAllRecording={handleToggleAllRecording}
              onSyncCloudEvents={handleSyncCloudEvents}
              onCaptureRecording={handleCaptureRecording}
              onToggleStar={handleToggleStar}
              onExportRecording={handleExportRecording}
              onOpenInFolder={async (id) => {
                if (api) await api.openRecordingInFolder(id)
              }}
            />
          ) : activeTab === 'recordings' ? (
            <RecordingsView
              cameras={cameras}
              recordings={recordings}
              storageStats={storageStats}
              defaultCaptureSeconds={settings.defaultCaptureSeconds}
              onCaptureRecording={handleCaptureRecording}
              onDeleteRecording={async (id) => {
                if (api) await api.deleteLocalRecording(id)
              }}
              onToggleStar={handleToggleStar}
              onExportRecording={handleExportRecording}
              onExportEvidenceBundle={handleExportEvidenceBundle}
              onImportVideos={handleImportVideos}
              onRescanStorage={handleRescanStorage}
              onPruneStorage={handlePruneStorage}
              onOpenInFolder={async (id) => {
                if (api) await api.openRecordingInFolder(id)
              }}
              onOpenRootFolder={async () => {
                if (api) await api.openRecordingsRootFolder()
              }}
              onListCloudRecordings={handleListCloudRecordings}
              onDownloadCloudRecording={handleDownloadCloudRecording}
            />
          ) : activeTab === 'sensors' ? (
            <SensorsView
              locations={locations}
              sensors={sensors}
              events={events}
              onSetAlarmMode={handleSetAlarmMode}
            />
          ) : activeTab === 'package-ai' ? (
            <PackageAiView
              cameras={cameras}
              settings={settings}
              detections={packageDetections}
              onUpdateSettings={handleUpdateSettings}
              onScanCamera={handleScanPackages}
              onClearDetections={async () => {
                if (api) await api.clearPackageDetections()
                setPackageDetections([])
              }}
              onTestAlert={handleTestAlert}
              onGoToSettings={() => setActiveTab('settings')}
            />
          ) : (
            <SettingsView
              connection={connection}
              settings={settings}
              cameras={cameras}
              onSwitchMode={handleSwitchMode}
              onLoginCredentials={handleLoginCredentials}
              onConnectToken={handleConnectToken}
              onDisconnectRing={handleDisconnectRing}
              onUpdateSettings={handleUpdateSettings}
              onChooseRecordingsFolder={handleChooseFolder}
              onChooseFailoverFolder={handleChooseFailoverFolder}
              onTestAiConnection={handleTestAiConnection}
            />
          )}
        </main>
      </div>

      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.tone}`}>
              <div className="toast-title">{t.title}</div>
              <div className="toast-body">{t.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
export default App
