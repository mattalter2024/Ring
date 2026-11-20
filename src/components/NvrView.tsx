import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Circle,
  FolderOpen,
  HardDrive,
  Moon,
  Network,
  RefreshCw,
  Scissors,
  ShieldAlert,
  ShieldCheck,
  Square,
  Usb,
} from 'lucide-react'
import type {
  AppSettings,
  AppSettingsPatch,
  NvrStatus,
  RingCameraInfo,
  SecurityEvent,
  StorageDriveInfo,
  StorageStats,
} from '@shared/types'
import { formatBytes, formatRelativeTime } from '@/utils/format'

interface NvrViewProps {
  cameras: RingCameraInfo[]
  settings: AppSettings
  nvrStatus: NvrStatus
  storageStats: StorageStats
  events: SecurityEvent[]
  nvrBusy: boolean
  onToggleAllRecording: () => Promise<void>
  onToggleCameraContinuous: (cameraId: string, enable: boolean) => Promise<void>
  onUpdateSettings: (patch: AppSettingsPatch) => Promise<void>
  onListStorageDrives: () => Promise<StorageDriveInfo[]>
  onSetPrimaryDrive: (drivePath: string) => Promise<void>
  onSetFailoverDrive: (drivePath: string) => Promise<void>
  onClearFailover: () => Promise<void>
  onChoosePrimaryFolder: () => Promise<void>
  onChooseFailoverFolder: () => Promise<void>
  onRescanStorage: () => Promise<void>
  onPruneStorage: () => Promise<void>
  onOpenRootFolder: () => Promise<void>
}

export function NvrView({
  cameras,
  settings,
  nvrStatus,
  storageStats,
  events,
  nvrBusy,
  onToggleAllRecording,
  onToggleCameraContinuous,
  onUpdateSettings,
  onListStorageDrives,
  onSetPrimaryDrive,
  onSetFailoverDrive,
  onClearFailover,
  onChoosePrimaryFolder,
  onChooseFailoverFolder,
  onRescanStorage,
  onPruneStorage,
  onOpenRootFolder,
}: NvrViewProps) {
  const [drives, setDrives] = useState<StorageDriveInfo[]>([])
  const [loadingDrives, setLoadingDrives] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)

  const refreshDrives = useCallback(async () => {
    setLoadingDrives(true)
    try {
      const list = await onListStorageDrives()
      setDrives(list)
    } finally {
      setLoadingDrives(false)
    }
  }, [onListStorageDrives])

  useEffect(() => {
    void refreshDrives()
  }, [refreshDrives, settings.recordingsDir, settings.failoverRecordingsDir])

  const totalDisk = storageStats.totalDiskBytes ?? 0
  const freeDisk = storageStats.freeDiskBytes ?? 0
  const usedDisk = totalDisk > 0 ? Math.max(0, totalDisk - freeDisk) : 0
  const unprotectedRingBytes = Math.max(
    0,
    storageStats.totalBytes - storageStats.protectedBytes,
  )
  const otherDiskBytes = Math.max(0, usedDisk - storageStats.totalBytes)

  const pct = (bytes: number) =>
    totalDisk > 0 ? Math.min(100, (bytes / totalDisk) * 100) : 0

  const healthMeta =
    storageStats.diskHealth === 'critical'
      ? { label: 'Critical Disk Space', cls: 'alert' }
      : storageStats.diskHealth === 'offline'
        ? { label: 'Storage Offline', cls: 'alert' }
        : storageStats.diskHealth === 'warning'
          ? {
              label: storageStats.usingFailover ? 'Failover Active' : 'Low Disk Warning',
              cls: 'warn',
            }
          : { label: 'Healthy', cls: 'ok' }

  const cameraUsageById = new Map(
    storageStats.perCameraUsage.map((u) => [u.cameraId, u]),
  )

  const nvrHealthEvents = events
    .filter((ev) => ev.kind === 'storage-alert' || ev.kind === 'nvr-health')
    .slice(0, 12)

  return (
    <div className="nvr-console">
      {/* Failover / Disk Alert Banners (only shown when action is needed) */}
      {storageStats.usingFailover && (
        <div className="nvr-alert-banner critical" role="alert">
          <ShieldAlert size={18} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>Primary Drive Offline — Failover Active</strong>
            <div className="mono" style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>
              Recording to {storageStats.activeRecordingsDir}. Reconnect{' '}
              {storageStats.recordingsDir} to auto-restore.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void refreshDrives()}
          >
            <RefreshCw size={13} />
            Check Drives
          </button>
        </div>
      )}

      {!storageStats.usingFailover &&
        (storageStats.diskHealth === 'warning' ||
          storageStats.diskHealth === 'critical') && (
          <div
            className={`nvr-alert-banner ${
              storageStats.diskHealth === 'critical' ? 'critical' : 'warning'
            }`}
            role="alert"
          >
            <AlertTriangle size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>
                {storageStats.diskHealth === 'critical'
                  ? 'Critical Disk Space — Auto-Pruning Old Clips'
                  : 'Low Disk Space Warning'}
              </strong>
              <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>
                {storageStats.freeDiskBytes !== null
                  ? `${formatBytes(storageStats.freeDiskBytes)} free.`
                  : 'Low available storage.'}{' '}
                Oldest unstarred clips are recycled automatically to keep at least{' '}
                {storageStats.minFreeDiskGb} GB free.
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={actionBusy}
              onClick={async () => {
                setActionBusy(true)
                try {
                  await onPruneStorage()
                } finally {
                  setActionBusy(false)
                }
              }}
            >
              <Scissors size={13} />
              Prune Now
            </button>
          </div>
        )}

      {/* NVR Status Hero & Drive Utilization */}
      <section className={`panel nvr-hero ${nvrStatus.active ? 'active' : ''}`}>
        <div className="nvr-hero-main">
          <div className="nvr-hero-left">
            <div className={`nvr-power-ring ${nvrStatus.active ? 'active' : ''}`}>
              <HardDrive size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 16 }}>
                  24/7 Continuous NVR
                </h2>
                <span className={`chip ${nvrStatus.active ? 'alert' : ''}`}>
                  <Circle
                    size={8}
                    fill={nvrStatus.active ? '#ef4444' : 'currentColor'}
                    color={nvrStatus.active ? '#ef4444' : 'currentColor'}
                  />
                  {nvrStatus.active
                    ? `Recording (${nvrStatus.activeCameraCount}/${cameras.length})`
                    : 'Standby'}
                </span>
                <span className={`chip ${healthMeta.cls}`}>
                  {storageStats.diskHealth === 'healthy' ? (
                    <ShieldCheck size={12} />
                  ) : (
                    <AlertTriangle size={12} />
                  )}
                  {healthMeta.label}
                </span>
              </div>
              <div className="nvr-hero-sub mono">
                <span title={storageStats.activeRecordingsDir}>
                  {storageStats.activeRecordingsDir}
                </span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              id="btn-nvr-console-toggle"
              type="button"
              className={`btn ${nvrStatus.active ? 'btn-danger' : 'btn-primary'}`}
              disabled={nvrBusy || cameras.length === 0}
              onClick={() => void onToggleAllRecording()}
            >
              {nvrStatus.active ? (
                <>
                  <Square size={13} fill="currentColor" />
                  {nvrBusy ? 'Stopping…' : 'Stop 24/7 NVR'}
                </>
              ) : (
                <>
                  <Circle size={12} fill="#ef4444" color="#ef4444" />
                  {nvrBusy ? 'Starting…' : 'Start 24/7 NVR'}
                </>
              )}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void onOpenRootFolder()}
            >
              <FolderOpen size={14} />
              Open Vault
            </button>
          </div>
        </div>

        {/* Segmented Drive Utilization Bar */}
        <div className="nvr-capacity-section">
          <div className="nvr-capacity-header">
            <span style={{ fontWeight: 600, fontSize: 13 }}>
              Drive Usage
            </span>
            <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {totalDisk > 0
                ? `${formatBytes(usedDisk)} / ${formatBytes(totalDisk)} (${formatBytes(freeDisk)} free)`
                : `${formatBytes(storageStats.totalBytes)} recorded`}
            </span>
          </div>

          <div className="unvr-storage-bar" role="img" aria-label="Disk capacity breakdown">
            <div
              className="unvr-seg ring"
              style={{ width: `${Math.max(unprotectedRingBytes > 0 ? 1.5 : 0, pct(unprotectedRingBytes))}%` }}
              title={`RingWatch 24/7 Footage: ${formatBytes(unprotectedRingBytes)}`}
            />
            <div
              className="unvr-seg protected"
              style={{ width: `${Math.max(storageStats.protectedBytes > 0 ? 1 : 0, pct(storageStats.protectedBytes))}%` }}
              title={`Protected / Starred Clips: ${formatBytes(storageStats.protectedBytes)}`}
            />
            <div
              className="unvr-seg other"
              style={{ width: `${pct(otherDiskBytes)}%` }}
              title={`Other Files on Drive: ${formatBytes(otherDiskBytes)}`}
            />
          </div>

          <div className="unvr-legend">
            <span>
              <i className="dot ring" />
              NVR Video ({formatBytes(unprotectedRingBytes)})
            </span>
            <span>
              <i className="dot protected" />
              Protected ({formatBytes(storageStats.protectedBytes)})
            </span>
            <span>
              <i className="dot free" />
              Free ({storageStats.freeDiskBytes !== null ? formatBytes(storageStats.freeDiskBytes) : '—'})
            </span>
            {storageStats.estimatedDaysRemaining !== null && (
              <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>
                Est. ~{storageStats.estimatedDaysRemaining}d capacity
                {storageStats.writeRateBytesPerHour > 0
                  ? ` · ${formatBytes(storageStats.writeRateBytesPerHour)}/hr`
                  : ''}
                {' · '}
                {storageStats.totalClips} clip{storageStats.totalClips === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Main 2-Column NVR Grid */}
      <div className="nvr-main-grid">
        {/* Left Column: Storage Drives + Per-Camera Channels */}
        <div className="form-stack">
          <section className="panel">
            <div className="panel-header">
              <h3>Storage Drives</h3>
              <button
                type="button"
                className="btn btn-sm"
                disabled={loadingDrives}
                onClick={() => void refreshDrives()}
              >
                <RefreshCw size={13} />
                {loadingDrives ? 'Scanning…' : 'Detect Drives'}
              </button>
            </div>

            <div className="panel-body form-stack">
              {drives.length === 0 ? (
                <div className="empty-state" style={{ padding: 20 }}>
                  <HardDrive size={20} />
                  <span>Click &ldquo;Detect Drives&rdquo; to see connected internal, USB, and NAS drives.</span>
                </div>
              ) : (
                <div className="drive-grid">
                  {drives.map((drive) => {
                    const drivePct =
                      drive.totalBytes && drive.usedBytes !== null
                        ? Math.min(100, (drive.usedBytes / drive.totalBytes) * 100)
                        : 0
                    const DriveIcon =
                      drive.driveType === 'removable'
                        ? Usb
                        : drive.driveType === 'network'
                          ? Network
                          : HardDrive
                    return (
                      <div
                        key={drive.id}
                        className={`drive-card ${
                          drive.isPrimary
                            ? 'is-primary'
                            : drive.isFailover
                              ? 'is-failover'
                              : ''
                        }`}
                      >
                        <div className="drive-card-top">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                            <DriveIcon
                              size={18}
                              color={
                                drive.driveType === 'removable'
                                  ? '#38bdf8'
                                  : drive.driveType === 'network'
                                    ? '#a78bfa'
                                    : '#94a3b8'
                              }
                            />
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  fontWeight: 600,
                                  fontSize: 13,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {drive.label}
                              </div>
                              <div
                                className="mono"
                                style={{ fontSize: 11, color: 'var(--text-muted)' }}
                              >
                                {drive.path} ·{' '}
                                {drive.driveType === 'removable'
                                  ? 'External USB'
                                  : drive.driveType === 'network'
                                    ? 'Network / NAS'
                                    : 'Internal'}
                              </div>
                            </div>
                          </div>

                          <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                            {drive.isPrimary && (
                              <span className="chip accent">Primary</span>
                            )}
                            {drive.isFailover && (
                              <span className="chip warn">Failover</span>
                            )}
                          </div>
                        </div>

                        <div className="drive-meter-track">
                          <div
                            className={`drive-meter-fill ${drivePct > 85 ? 'warn' : ''}`}
                            style={{ width: `${drivePct}%` }}
                          />
                        </div>

                        <div className="drive-card-bottom">
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                            {drive.freeBytes !== null
                              ? `${formatBytes(drive.freeBytes)} free`
                              : 'Capacity unknown'}
                            {drive.totalBytes !== null
                              ? ` / ${formatBytes(drive.totalBytes)}`
                              : ''}
                          </span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {!drive.isPrimary && (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={!drive.writable}
                                onClick={async () => {
                                  await onSetPrimaryDrive(drive.path)
                                  await refreshDrives()
                                }}
                              >
                                Use as Primary
                              </button>
                            )}
                            {!drive.isFailover && !drive.isPrimary && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={!drive.writable}
                                onClick={async () => {
                                  await onSetFailoverDrive(drive.path)
                                  await refreshDrives()
                                }}
                              >
                                Failover
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <details className="advanced-drawer">
                <summary>Failover &amp; Custom Folders</summary>
                <div className="advanced-drawer-body">
                  <div className="nvr-paths-box mono">
                    <div>
                      <span className="nvr-path-tag primary">PRIMARY</span>
                      <span title={settings.recordingsDir}>{settings.recordingsDir}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span className="nvr-path-tag failover">FAILOVER</span>
                        <span title={settings.failoverRecordingsDir || 'Built-in local fallback'}>
                          {settings.failoverRecordingsDir || 'Automatic local fallback'}
                        </span>
                      </div>
                      {settings.failoverRecordingsDir && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => void onClearFailover()}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void onChoosePrimaryFolder()}
                    >
                      <FolderOpen size={13} />
                      Choose Primary Folder
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void onChooseFailoverFolder()}
                    >
                      <FolderOpen size={13} />
                      Choose Failover Folder
                    </button>
                  </div>
                </div>
              </details>
            </div>
          </section>

          {/* Per-Camera 24/7 Channels */}
          <section className="panel">
            <div className="panel-header">
              <h3>Camera Channels ({cameras.length})</h3>
              <span className="chip">
                <Activity size={12} />
                {settings.continuousSegmentSeconds}s clips
              </span>
            </div>
            <div className="panel-body">
              {cameras.length === 0 ? (
                <div className="empty-state" style={{ padding: 24 }}>
                  <span>Connect your Ring account in Settings to start 24/7 recording.</span>
                </div>
              ) : (
                <div className="nvr-camera-table">
                  {cameras.map((cam) => {
                    const worker = nvrStatus.cameras[cam.id]
                    const usage = cameraUsageById.get(cam.id)
                    const isActive = Boolean(worker && worker.state !== 'stopped')
                    const stateCls =
                      worker?.state === 'recording'
                        ? 'ok'
                        : worker?.state === 'stalled' || worker?.state === 'error'
                          ? 'alert'
                          : worker?.state === 'reconnecting' || worker?.state === 'connecting'
                            ? 'warn'
                            : ''
                    return (
                      <div key={cam.id} className="nvr-cam-row">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <strong style={{ fontSize: 13.5 }}>{cam.name}</strong>
                            <span className={`chip ${stateCls}`}>
                              {worker?.state ? worker.state.toUpperCase() : 'IDLE'}
                            </span>
                            {cam.batteryPercent !== null && (
                              <span className="chip">{cam.batteryPercent}%</span>
                            )}
                          </div>
                          <div className="mono nvr-cam-meta">
                            <span>{worker?.segmentsCaptured ?? 0} clips</span>
                            <span>·</span>
                            <span>
                              {usage ? formatBytes(usage.totalBytes) : '0 B'} stored
                            </span>
                            {worker?.estimatedBitrateKbps ? (
                              <>
                                <span>·</span>
                                <span>{worker.estimatedBitrateKbps} kbps</span>
                              </>
                            ) : null}
                          </div>
                          {worker?.lastError && (
                            <div style={{ fontSize: 11.5, color: '#fca5a5', marginTop: 3 }}>
                              {worker.lastError}
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          className={`btn btn-sm ${isActive ? 'btn-danger' : 'btn-primary'}`}
                          onClick={() => void onToggleCameraContinuous(cam.id, !isActive)}
                        >
                          {isActive ? 'Stop' : 'Record 24/7'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right Column: Core Recording & Storage Policy */}
        <div className="form-stack">
          <section className="panel">
            <div className="panel-header">
              <h3>Recording &amp; Retention Policy</h3>
            </div>
            <div className="panel-body form-stack">
              <div className="toggle-row">
                <div>
                  <div className="toggle-label-main">
                    Auto-Start 24/7 Recording
                  </div>
                  <div className="toggle-label-sub">
                    Record all cameras continuously as soon as Ring connects
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.continuousAutoStart}
                  className={`switch ${settings.continuousAutoStart ? 'on' : ''}`}
                  onClick={() =>
                    void onUpdateSettings({
                      continuousAutoStart: !settings.continuousAutoStart,
                    })
                  }
                />
              </div>

              <div className="toggle-row">
                <div>
                  <div className="toggle-label-main">
                    <Moon size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
                    Keep PC Awake While Recording
                  </div>
                  <div className="toggle-label-sub">
                    Prevent host sleep so overnight recording never pauses
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.preventSleepWhileRecording}
                  className={`switch ${settings.preventSleepWhileRecording ? 'on' : ''}`}
                  onClick={() =>
                    void onUpdateSettings({
                      preventSleepWhileRecording: !settings.preventSleepWhileRecording,
                    })
                  }
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="field">
                  <label htmlFor="nvr-quota-select">Storage Limit</label>
                  <select
                    id="nvr-quota-select"
                    className="select"
                    value={settings.maxStorageGb}
                    onChange={(e) =>
                      void onUpdateSettings({ maxStorageGb: Number(e.target.value) })
                    }
                  >
                    <option value={25}>25 GB</option>
                    <option value={50}>50 GB</option>
                    <option value={100}>100 GB</option>
                    <option value={250}>250 GB</option>
                    <option value={500}>500 GB</option>
                    <option value={1000}>1 TB</option>
                    <option value={2000}>2 TB</option>
                    <option value={4000}>4 TB</option>
                    <option value={8000}>8 TB</option>
                    <option value={0}>Unlimited (Full drive)</option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="nvr-retention-select">Keep Footage For</label>
                  <select
                    id="nvr-retention-select"
                    className="select"
                    value={settings.retentionDays}
                    onChange={(e) =>
                      void onUpdateSettings({ retentionDays: Number(e.target.value) })
                    }
                  >
                    <option value={7}>7 days</option>
                    <option value={14}>14 days</option>
                    <option value={30}>30 days</option>
                    <option value={60}>60 days</option>
                    <option value={90}>90 days</option>
                    <option value={180}>180 days</option>
                    <option value={0}>Until storage is full</option>
                  </select>
                </div>
              </div>

              <details className="advanced-drawer">
                <summary>Advanced NVR &amp; Disk Settings</summary>
                <div className="advanced-drawer-body">
                  <div className="field">
                    <label htmlFor="nvr-segment-seconds">Rolling Clip Length</label>
                    <select
                      id="nvr-segment-seconds"
                      className="select"
                      value={settings.continuousSegmentSeconds}
                      onChange={(e) =>
                        void onUpdateSettings({
                          continuousSegmentSeconds: Number(e.target.value),
                        })
                      }
                    >
                      <option value={60}>60 seconds (Fastest timeline refresh)</option>
                      <option value={120}>120 seconds (Recommended — 2 min)</option>
                      <option value={180}>180 seconds (3 min)</option>
                      <option value={300}>300 seconds (5 min)</option>
                    </select>
                  </div>

                  <div className="toggle-row">
                    <div>
                      <div className="toggle-label-main">Skip Battery Cameras</div>
                      <div className="toggle-label-sub">
                        Only auto-record wired cameras to save battery
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.continuousSkipBatteryCams}
                      className={`switch ${settings.continuousSkipBatteryCams ? 'on' : ''}`}
                      onClick={() =>
                        void onUpdateSettings({
                          continuousSkipBatteryCams: !settings.continuousSkipBatteryCams,
                        })
                      }
                    />
                  </div>

                  <div className="toggle-row">
                    <div>
                      <div className="toggle-label-main">Date &amp; Camera Folders</div>
                      <div className="toggle-label-sub">
                        Save clips into <code className="mono">YYYY-MM-DD/camera/</code>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.organizeByDateFolder}
                      className={`switch ${settings.organizeByDateFolder ? 'on' : ''}`}
                      onClick={() =>
                        void onUpdateSettings({
                          organizeByDateFolder: !settings.organizeByDateFolder,
                        })
                      }
                    />
                  </div>

                  <div className="toggle-row">
                    <div>
                      <div className="toggle-label-main">
                        <Bell size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
                        Low Disk &amp; Health Alerts
                      </div>
                      <div className="toggle-label-sub">
                        Desktop alerts for low disk space, failover, or camera drops
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.nvrNotificationsEnabled}
                      className={`switch ${settings.nvrNotificationsEnabled ? 'on' : ''}`}
                      onClick={() =>
                        void onUpdateSettings({
                          nvrNotificationsEnabled: !settings.nvrNotificationsEnabled,
                        })
                      }
                    />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="field">
                      <label htmlFor="nvr-low-warn-gb">Low Disk Warning (GB)</label>
                      <input
                        id="nvr-low-warn-gb"
                        type="number"
                        min={2}
                        max={500}
                        className="input mono"
                        value={settings.lowDiskWarningGb}
                        onChange={(e) =>
                          void onUpdateSettings({
                            lowDiskWarningGb: Number(e.target.value) || 20,
                          })
                        }
                      />
                    </div>

                    <div className="field">
                      <label htmlFor="nvr-min-free-gb">Min Free Floor (GB)</label>
                      <input
                        id="nvr-min-free-gb"
                        type="number"
                        min={1}
                        max={250}
                        className="input mono"
                        value={settings.minFreeDiskGb}
                        onChange={(e) =>
                          void onUpdateSettings({
                            minFreeDiskGb: Number(e.target.value) || 10,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={actionBusy}
                      onClick={async () => {
                        setActionBusy(true)
                        try {
                          await onRescanStorage()
                          await refreshDrives()
                        } finally {
                          setActionBusy(false)
                        }
                      }}
                    >
                      <RefreshCw size={13} />
                      Rescan Disk
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={actionBusy}
                      onClick={async () => {
                        setActionBusy(true)
                        try {
                          await onPruneStorage()
                        } finally {
                          setActionBusy(false)
                        }
                      }}
                    >
                      <Scissors size={13} />
                      Prune Old Clips
                    </button>
                  </div>
                </div>
              </details>

              <details className="advanced-drawer" open={nvrHealthEvents.length > 0}>
                <summary>
                  System Health Log ({nvrHealthEvents.length})
                </summary>
                <div className="advanced-drawer-body">
                  {nvrHealthEvents.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      <CheckCircle2 size={16} color="#4ade80" />
                      <span>All NVR systems healthy — no warnings or stalls.</span>
                    </div>
                  ) : (
                    <div className="event-list">
                      {nvrHealthEvents.map((ev) => (
                        <div key={ev.id} className="event-item">
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span
                                className={`chip ${
                                  ev.severity === 'alert'
                                    ? 'alert'
                                    : ev.severity === 'warning'
                                      ? 'warn'
                                      : ev.severity === 'success'
                                        ? 'ok'
                                        : ''
                                }`}
                              >
                                {ev.kind === 'storage-alert' ? 'STORAGE' : 'WATCHDOG'}
                              </span>
                              <strong style={{ fontSize: 12.5 }}>{ev.title}</strong>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                              {ev.detail}
                            </div>
                            <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                              {formatRelativeTime(ev.timestamp)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
