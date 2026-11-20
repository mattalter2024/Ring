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
import { LoginGate } from '@/components/LoginGate'
import { playAlertChime } from '@/utils/audioChime'
import { formatBytes } from '@/utils/format'

export function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('cameras')
  const [focusedCameraId, setFocusedCameraId] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [nvrBusy, setNvrBusy] = useState(false)
  const [autoLiveEnabled, setAutoLiveEnabled] = useState(true)
  const [connectingCameraIds, setConnectingCameraIds] = useState<Record<string, boolean>>({})

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

  // Keep latest live-stream state in refs so the 5-second watchdog never triggers idle React re-renders
  const autoLiveStateRef = useRef({
    cameras,
    streamsByCamera,
    nvrCameras: nvrStatus.cameras,
    mode: connection.mode,
  })
  autoLiveStateRef.current = {
    cameras,
    streamsByCamera,
    nvrCameras: nvrStatus.cameras,
    mode: connection.mode,
  }

  const ensureOnlineCamerasLive = useCallback(() => {
    const {
      cameras: currentCameras,
      streamsByCamera: currentStreams,
      nvrCameras,
      mode,
    } = autoLiveStateRef.current
    if (currentCameras.length === 0) return

    const now = Date.now()
    const eligible = currentCameras.filter((cam) => {
      if (!cam.online) return false
      if (currentStreams[cam.id]) return false
      if (connectingRef.current.has(cam.id)) return false
      if (manuallyStoppedRef.current.has(cam.id)) return false
      const nvrRecording = nvrCameras[cam.id]?.state === 'recording'
      const lastFail = lastAutoFailRef.current[cam.id] ?? 0
      const failCount = failCountRef.current[cam.id] ?? 0
      const retryCooldownMs = Math.min(15_000, Math.max(5_000, failCount * 5_000))
      if (!nvrRecording && lastFail > 0 && now - lastFail < retryCooldownMs) return false
      return true
    })

    if (eligible.length === 0) return

    eligible.forEach((cam, idx) => {
      const nvrRecording = nvrCameras[cam.id]?.state === 'recording'
      const delayMs = mode === 'demo' || nvrRecording ? 0 : idx * 250
      if (delayMs === 0) {
        void startStreamInternal(cam.id, true)
      } else {
        setTimeout(() => {
          void startStreamInternal(cam.id, true)
        }, delayMs)
      }
    })
  }, [startStreamInternal])

  // Trigger immediately when cameras, streams, or NVR status changes while viewing Live Cameras
  useEffect(() => {
    if (loading || activeTab !== 'cameras' || !autoLiveEnabled) return
    ensureOnlineCamerasLive()
  }, [
    loading,
    activeTab,
    autoLiveEnabled,
    cameras,
    streamsByCamera,
    nvrStatus.cameras,
    ensureOnlineCamerasLive,
  ])

  // Silent 5-second background watchdog with zero idle React re-renders
  useEffect(() => {
    if (loading || activeTab !== 'cameras' || !autoLiveEnabled) return
    const timer = setInterval(() => {
      if (!document.hidden) {
        ensureOnlineCamerasLive()
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [loading, activeTab, autoLiveEnabled, ensureOnlineCamerasLive])

  const handleCaptureRecording = async (
    cameraId: string,
    durationSeconds: number,
  ) => {
    if (!api) {
      pushToast(
        'Backend Unavailable',
        'MP4 capture requires a connected RingWatch NVR backend server.',
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
        error: 'Ring sign-in requires a connected RingWatch backend server.',
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
    const entered = window.prompt(
      'Enter full primary recordings folder path on the RingWatch NVR server:',
      settings.recordingsDir,
    )
    if (!entered || !entered.trim()) return
    try {
      const updated = await api.updateSettings({ recordingsDir: entered.trim() })
      setSettings(updated)
      const res = await api.rescanLocalStorage()
      setRecordings(res.recordings)
      setStorageStats(res.stats)
      pushToast('Primary Storage Updated', `Recordings will save to ${updated.recordingsDir}`, 'ok')
    } catch (err) {
      pushToast(
        'Folder Update Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    }
  }

  const handleChooseFailoverFolder = async () => {
    if (!api) return
    const entered = window.prompt(
      'Enter full failover folder path on the RingWatch NVR server (leave blank to cancel):',
      settings.failoverRecordingsDir || settings.recordingsDir,
    )
    if (!entered || !entered.trim()) return
    try {
      const updated = await api.updateSettings({ failoverRecordingsDir: entered.trim() })
      setSettings(updated)
      const stats = await api.getStorageStats()
      setStorageStats(stats)
      pushToast('Failover Storage Updated', `Failover storage set to ${updated.failoverRecordingsDir}`, 'ok')
    } catch (err) {
      pushToast(
        'Failover Update Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
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
        'Backend Unavailable',
        'SHA-256 Evidence Bundle export requires a connected RingWatch backend server.',
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
        message: 'Connect to the RingWatch backend server to test live Vision API.',
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
        'Backend Unavailable',
        'Continuous all-camera MP4 recording requires a connected RingWatch backend server.',
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
        'Backend Unavailable',
        'Continuous MP4 recording requires a connected RingWatch backend server.',
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

  if (!loading && authStatus.authEnabled && !authStatus.authenticated) {
    return <LoginGate onLogin={login} />
  }

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
              authStatus={authStatus}
              onSwitchMode={handleSwitchMode}
              onLoginCredentials={handleLoginCredentials}
              onConnectToken={handleConnectToken}
              onDisconnectRing={handleDisconnectRing}
              onUpdateSettings={handleUpdateSettings}
              onChooseRecordingsFolder={handleChooseFolder}
              onChooseFailoverFolder={handleChooseFailoverFolder}
              onTestAiConnection={handleTestAiConnection}
              onUpdateAuthPassword={setAuthPassword}
              onLogout={logout}
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
