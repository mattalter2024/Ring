import { useEffect, useMemo, useState } from 'react'
import {
  CloudDownload,
  Download,
  Film,
  FolderOpen,
  HardDrive,
  Package,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  CloudRecordingItem,
  LocalRecordingItem,
  RingCameraInfo,
  StorageStats,
} from '@shared/types'
import { formatBytes, formatDuration, formatRelativeTime } from '@/utils/format'

interface RecordingsViewProps {
  cameras: RingCameraInfo[]
  recordings: LocalRecordingItem[]
  storageStats: StorageStats
  defaultCaptureSeconds: number
  onCaptureRecording: (cameraId: string, durationSeconds: number) => Promise<void>
  onDeleteRecording: (recordingId: string) => Promise<void>
  onToggleStar: (recordingId: string) => Promise<void>
  onExportRecording: (recordingId: string) => Promise<void>
  onExportEvidenceBundle?: (recordingId: string) => Promise<void>
  onImportVideos: () => Promise<void>
  onRescanStorage: () => Promise<void>
  onPruneStorage: () => Promise<void>
  onOpenInFolder: (recordingId: string) => Promise<void>
  onOpenRootFolder: () => Promise<void>
  onListCloudRecordings: (cameraId: string) => Promise<CloudRecordingItem[]>
  onDownloadCloudRecording: (cameraId: string, dingId: string) => Promise<void>
}

export function RecordingsView({
  cameras,
  recordings,
  storageStats,
  defaultCaptureSeconds,
  onCaptureRecording,
  onDeleteRecording,
  onToggleStar,
  onExportRecording,
  onExportEvidenceBundle,
  onImportVideos,
  onOpenInFolder,
  onOpenRootFolder,
  onListCloudRecordings,
  onDownloadCloudRecording,
}: RecordingsViewProps) {
  const [tab, setTab] = useState<'local' | 'cloud'>('local')
  const [selectedLocalId, setSelectedLocalId] = useState<string | null>(
    recordings[0]?.id ?? null,
  )
  const [filterCameraId, setFilterCameraId] = useState<string>('all')
  const [starredOnly, setStarredOnly] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(60)
  const [cloudCameraId, setCloudCameraId] = useState<string>(cameras[0]?.id ?? '')
  const [cloudItems, setCloudItems] = useState<CloudRecordingItem[]>([])
  const [loadingCloud, setLoadingCloud] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    setVisibleLimit(60)
  }, [filterCameraId, starredOnly])

  useEffect(() => {
    if (!cloudCameraId && cameras[0]?.id) {
      setCloudCameraId(cameras[0].id)
    }
  }, [cameras, cloudCameraId])

  useEffect(() => {
    if (recordings.length > 0 && !recordings.some((r) => r.id === selectedLocalId)) {
      setSelectedLocalId(recordings[0].id)
    }
  }, [recordings, selectedLocalId])

  const loadCloud = async (camId: string) => {
    if (!camId) return
    setLoadingCloud(true)
    try {
      const items = await onListCloudRecordings(camId)
      setCloudItems(items)
    } finally {
      setLoadingCloud(false)
    }
  }

  useEffect(() => {
    if (tab === 'cloud' && cloudCameraId) {
      void loadCloud(cloudCameraId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, cloudCameraId])

  const cameraSnapshotById = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of cameras) {
      if (c.lastSnapshotDataUrl) map.set(c.id, c.lastSnapshotDataUrl)
    }
    return map
  }, [cameras])

  const filteredLocal = useMemo(
    () =>
      recordings.filter((r) => {
        if (filterCameraId !== 'all' && r.cameraId !== filterCameraId) return false
        if (starredOnly && !r.starred) return false
        return true
      }),
    [recordings, filterCameraId, starredOnly],
  )

  const visibleLocal = useMemo(
    () => filteredLocal.slice(0, visibleLimit),
    [filteredLocal, visibleLimit],
  )

  const selectedLocal =
    filteredLocal.find((r) => r.id === selectedLocalId) ?? filteredLocal[0] ?? null

  return (
    <div>
      {/* Compact Vault Summary Bar */}
      <section className="panel storage-banner" aria-label="Local video storage status">
        <div className="storage-banner-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <HardDrive size={18} color="var(--accent)" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                {formatBytes(storageStats.totalBytes)} used
                {storageStats.maxStorageGb > 0 ? ` / ${storageStats.maxStorageGb} GB` : ''}
                {storageStats.freeDiskBytes !== null
                  ? ` · ${formatBytes(storageStats.freeDiskBytes)} free`
                  : ''}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={storageStats.recordingsDir}
              >
                {storageStats.recordingsDir}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <button
              id="btn-import-videos"
              type="button"
              className="btn btn-sm"
              onClick={() => void onImportVideos()}
            >
              <Upload size={13} />
              Import MP4
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void onOpenRootFolder()}
            >
              <FolderOpen size={13} />
              Open Folder
            </button>
          </div>
        </div>
      </section>

      <div className="tabs-row">
        <button
          id="tab-local-recordings"
          type="button"
          className={`tab-btn ${tab === 'local' ? 'active' : ''}`}
          onClick={() => setTab('local')}
        >
          Local MP4 Vault ({recordings.length})
        </button>
        <button
          id="tab-cloud-recordings"
          type="button"
          className={`tab-btn ${tab === 'cloud' ? 'active' : ''}`}
          onClick={() => setTab('cloud')}
        >
          Ring Cloud Events
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {cameras[0] && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={capturing}
              onClick={async () => {
                setCapturing(true)
                try {
                  const targetId =
                    filterCameraId !== 'all' ? filterCameraId : cameras[0].id
                  await onCaptureRecording(targetId, defaultCaptureSeconds)
                } finally {
                  setCapturing(false)
                }
              }}
            >
              <Film size={13} />
              {capturing ? 'Capturing MP4…' : 'Capture Clip Now'}
            </button>
          )}
        </div>
      </div>

      {tab === 'local' ? (
        <div className="recordings-layout">
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  aria-label="Filter recordings by camera"
                  className="select"
                  style={{ width: 220 }}
                  value={filterCameraId}
                  onChange={(e) => setFilterCameraId(e.target.value)}
                >
                  <option value="all">All Cameras</option>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`btn btn-sm ${starredOnly ? 'btn-warn' : ''}`}
                  onClick={() => setStarredOnly((s) => !s)}
                >
                  <Star size={13} fill={starredOnly ? 'currentColor' : 'none'} />
                  Protected Only
                </button>
              </div>
              <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                {filteredLocal.length} local clip{filteredLocal.length === 1 ? '' : 's'}
              </span>
            </div>

            {filteredLocal.length === 0 ? (
              <div className="panel">
                <div className="empty-state">
                  <Film size={28} />
                  <strong>No local recordings match this filter</strong>
                  <span>
                    Click &ldquo;Capture Clip Now&rdquo;, import existing MP4 files, or
                    download clips from Ring Cloud.
                  </span>
                </div>
              </div>
            ) : (
              <div className="recording-list">
                {visibleLocal.map((rec) => {
                  const thumbSrc =
                    rec.thumbnailDataUrl || cameraSnapshotById.get(rec.cameraId)
                  return (
                  <div
                    key={rec.id}
                    className={`recording-row ${
                      selectedLocal?.id === rec.id ? 'selected' : ''
                    }`}
                    onClick={() => setSelectedLocalId(rec.id)}
                  >
                    {thumbSrc ? (
                      <img
                        src={thumbSrc}
                        alt={rec.cameraName}
                        loading="lazy"
                        decoding="async"
                        className="recording-thumb"
                      />
                    ) : (
                      <div
                        className="recording-thumb"
                        style={{ display: 'grid', placeItems: 'center' }}
                      >
                        <PlayCircle size={22} color="#6c7f96" />
                      </div>
                    )}

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                          {rec.cameraName}
                        </span>
                        {rec.starred && (
                          <Star size={12} color="#fbbf24" fill="#fbbf24" />
                        )}
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 11.5,
                          color: 'var(--text-muted)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {rec.fileName}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          marginTop: 5,
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span className="chip">{rec.trigger}</span>
                        <span
                          className="mono"
                          style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}
                        >
                          {formatDuration(rec.durationSeconds)} ·{' '}
                          {formatBytes(rec.sizeBytes)}
                        </span>
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {formatRelativeTime(rec.createdAt)}
                        </span>
                      </div>
                    </div>

                    <div
                      style={{ display: 'flex', gap: 5 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className={`btn btn-icon ${rec.starred ? 'btn-warn' : ''}`}
                        title={
                          rec.starred
                            ? 'Unprotect clip'
                            : 'Star/Protect clip from auto-pruning'
                        }
                        onClick={() => void onToggleStar(rec.id)}
                      >
                        <Star size={13} fill={rec.starred ? 'currentColor' : 'none'} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        title="Export copy of MP4"
                        onClick={() => void onExportRecording(rec.id)}
                      >
                        <Download size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        title="Show in Windows Explorer"
                        onClick={() => void onOpenInFolder(rec.id)}
                      >
                        <FolderOpen size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon btn-danger"
                        title="Delete recording"
                        onClick={() => void onDeleteRecording(rec.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  )
                })}
                {filteredLocal.length > visibleLocal.length && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}
                    onClick={() => setVisibleLimit((n) => n + 80)}
                  >
                    Show More ({filteredLocal.length - visibleLocal.length} remaining)
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="panel player-sticky">
            <div className="panel-header">
              <h3>Clip Playback</h3>
              {selectedLocal && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void onExportRecording(selectedLocal.id)}
                  >
                    <Download size={13} />
                    Export
                  </button>
                  {onExportEvidenceBundle && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Export MP4 plus tamper-evident SHA-256 .evidence.json manifest"
                      onClick={() => void onExportEvidenceBundle(selectedLocal.id)}
                    >
                      <ShieldCheck size={13} />
                      Evidence Bundle
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void onOpenInFolder(selectedLocal.id)}
                  >
                    <FolderOpen size={13} />
                    Explorer
                  </button>
                </div>
              )}
            </div>
            <div className="panel-body">
              {selectedLocal ? (
                <div className="form-stack">
                  <div className="player-video-box">
                    {selectedLocal.playbackUrl ? (
                      <video
                        key={selectedLocal.id}
                        src={selectedLocal.playbackUrl}
                        poster={selectedLocal.thumbnailDataUrl}
                        controls
                      />
                    ) : (
                      <div className="empty-state">
                        <span>Playback available inside Electron desktop app</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600 }}>{selectedLocal.cameraName}</div>
                    <div
                      className="mono"
                      style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}
                    >
                      {selectedLocal.fileName}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        marginTop: 6,
                      }}
                    >
                      Captured {new Date(selectedLocal.createdAt).toLocaleString()} ·{' '}
                      {formatBytes(selectedLocal.sizeBytes)}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <PlayCircle size={26} />
                  <span>Select a local recording to play</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="panel">
          <div className="panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3>Ring Cloud Event History</h3>
              <select
                aria-label="Select camera for cloud recordings"
                className="select"
                style={{ width: 230 }}
                value={cloudCameraId}
                onChange={(e) => setCloudCameraId(e.target.value)}
              >
                {cameras.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={loadingCloud}
              onClick={() => void loadCloud(cloudCameraId)}
            >
              <RefreshCw size={13} />
              {loadingCloud ? 'Loading…' : 'Reload'}
            </button>
          </div>
          <div className="panel-body">
            {cloudItems.length === 0 ? (
              <div className="empty-state">
                <CloudDownload size={26} />
                <span>No Ring cloud clips found for this camera.</span>
              </div>
            ) : (
              <div className="recording-list">
                {cloudItems.map((ev) => (
                  <div
                    key={ev.id}
                    className="event-item"
                    style={{ justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong>{ev.cameraName}</strong>
                        <span className="chip accent">{ev.kind}</span>
                        {ev.cvPackageDetected && (
                          <span className="chip warn">
                            <Package size={11} />
                            Package Event
                          </span>
                        )}
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 12,
                          color: 'var(--text-muted)',
                          marginTop: 4,
                        }}
                      >
                        {new Date(ev.createdAt).toLocaleString()} ·{' '}
                        {formatDuration(ev.durationSeconds)} · ID {ev.id}
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={downloadingId === ev.id}
                      onClick={async () => {
                        setDownloadingId(ev.id)
                        try {
                          await onDownloadCloudRecording(ev.cameraId, ev.id)
                          setTab('local')
                        } finally {
                          setDownloadingId(null)
                        }
                      }}
                    >
                      <CloudDownload size={14} />
                      {downloadingId === ev.id ? 'Saving…' : 'Save to Local Vault'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
