import { useCallback, useState } from 'react'
import type {
  AppMode,
  AppSettingsPatch,
  CloudRecordingItem,
  PackageDetectionRecord,
  RingAuthStepResult,
} from '@shared/types'
import { useRingWatch } from '@/hooks/useRingWatch'
import { Sidebar, type NavTab } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { CamerasView } from '@/components/CamerasView'
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

  const handleStartStream = async (cameraId: string) => {
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
    try {
      const session = await api.startLiveStream(cameraId)
      setStreamsByCamera((prev) => ({ ...prev, [cameraId]: session }))
    } catch (err) {
      pushToast('Stream Failed', err instanceof Error ? err.message : String(err), 'err')
    }
  }

  const handleStopStream = async (cameraId: string) => {
    if (api) {
      await api.stopLiveStream(cameraId)
    }
    setStreamsByCamera((prev) => {
      const next = { ...prev }
      delete next[cameraId]
      return next
    })
  }

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
    if (res.status === 'authenticated' && res.connection) {
      setConnection(res.connection)
      pushToast('Ring Connected', res.connection.accountLabel ?? 'Connected to Ring.', 'ok')
    }
    return res
  }

  const handleConnectToken = async (token: string) => {
    if (!api) return
    const status = await api.connectWithToken(token)
    setConnection(status)
    if (status.connected) {
      pushToast('Ring Connected', status.accountLabel ?? 'Connected via token.', 'ok')
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
      pushToast('Folder Updated', `Recordings will save to ${dir}`, 'ok')
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
          isRefreshing={isRefreshing}
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
              recordingsCount={recordings.length}
              packageDetections={packageDetections}
              defaultCaptureSeconds={settings.defaultCaptureSeconds}
              focusedCameraId={focusedCameraId}
              onSelectFocusCamera={setFocusedCameraId}
              onStartStream={handleStartStream}
              onStopStream={handleStopStream}
              onCaptureRecording={handleCaptureRecording}
              onCaptureSnapshot={handleCaptureSnapshot}
              onScanPackages={handleScanPackages}
              onToggleLight={handleToggleLight}
              onToggleSiren={handleToggleSiren}
            />
          ) : activeTab === 'timeline' ? (
            <TimelineView
              cameras={cameras}
              recordings={recordings}
              events={events}
              packageDetections={packageDetections}
              defaultCaptureSeconds={settings.defaultCaptureSeconds}
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
              onSwitchMode={handleSwitchMode}
              onLoginCredentials={handleLoginCredentials}
              onConnectToken={handleConnectToken}
              onDisconnectRing={handleDisconnectRing}
              onUpdateSettings={handleUpdateSettings}
              onChooseRecordingsFolder={handleChooseFolder}
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
