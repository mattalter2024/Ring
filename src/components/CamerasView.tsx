import { useState } from 'react'
import {
  Battery,
  Camera,
  Circle,
  LayoutGrid,
  Lightbulb,
  Maximize2,
  PackageSearch,
  Play,
  Siren,
  Square,
  Wifi,
} from 'lucide-react'
import type {
  LiveStreamSession,
  PackageDetectionRecord,
  RingCameraInfo,
} from '@shared/types'
import { formatRelativeTime, formatSignalQuality } from '@/utils/format'
import { LiveVideoPlayer } from './LiveVideoPlayer'

interface CamerasViewProps {
  cameras: RingCameraInfo[]
  streamsByCamera: Record<string, LiveStreamSession>
  recordingsCount: number
  packageDetections: PackageDetectionRecord[]
  defaultCaptureSeconds: number
  focusedCameraId: string | null
  onSelectFocusCamera: (cameraId: string | null) => void
  onStartStream: (cameraId: string) => Promise<void>
  onStopStream: (cameraId: string) => Promise<void>
  onCaptureRecording: (cameraId: string, durationSeconds: number) => Promise<void>
  onCaptureSnapshot: (cameraId: string) => Promise<void>
  onScanPackages: (cameraId: string) => Promise<void>
  onToggleLight: (cameraId: string, on: boolean) => Promise<void>
  onToggleSiren: (cameraId: string, on: boolean) => Promise<void>
}

export function CamerasView({
  cameras,
  streamsByCamera,
  recordingsCount,
  packageDetections,
  defaultCaptureSeconds,
  focusedCameraId,
  onSelectFocusCamera,
  onStartStream,
  onStopStream,
  onCaptureRecording,
  onCaptureSnapshot,
  onScanPackages,
  onToggleLight,
  onToggleSiren,
}: CamerasViewProps) {
  const [captureSeconds, setCaptureSeconds] = useState(defaultCaptureSeconds)
  const [busyByCamera, setBusyByCamera] = useState<Record<string, string>>({})

  const runBusy = async (
    cameraId: string,
    label: string,
    fn: () => Promise<void>,
  ) => {
    setBusyByCamera((prev) => ({ ...prev, [cameraId]: label }))
    try {
      await fn()
    } finally {
      setBusyByCamera((prev) => {
        const next = { ...prev }
        delete next[cameraId]
        return next
      })
    }
  }

  const onlineCount = cameras.filter((c) => c.online).length
  const liveCount = Object.keys(streamsByCamera).length
  const positivePackages = packageDetections.filter((d) => d.packageDetected).length

  const focusedCamera = focusedCameraId
    ? cameras.find((c) => c.id === focusedCameraId) ?? cameras[0] ?? null
    : null

  return (
    <div>
      <section className="telemetry-strip" aria-label="System telemetry">
        <div className="telemetry-card">
          <span className="telemetry-label">Cameras Online</span>
          <span className="telemetry-value">
            {onlineCount}/{cameras.length}
          </span>
          <span className="telemetry-note">Connected Ring devices</span>
        </div>
        <div className="telemetry-card">
          <span className="telemetry-label">Active Live Streams</span>
          <span className="telemetry-value">{liveCount}</span>
          <span className="telemetry-note">Low-latency HLS / preview</span>
        </div>
        <div className="telemetry-card">
          <span className="telemetry-label">Local MP4 Vault</span>
          <span className="telemetry-value">{recordingsCount}</span>
          <span className="telemetry-note">Saved to Windows folder</span>
        </div>
        <div className="telemetry-card">
          <span className="telemetry-label">AI Package Alerts</span>
          <span className="telemetry-value">{positivePackages}</span>
          <span className="telemetry-note">Detected across scans</span>
        </div>
      </section>

      {focusedCamera ? (
        <section className="theater-layout" aria-label="Focused camera live view">
          <div className="theater-stage">
            <div className="camera-viewport">
              <LiveVideoPlayer
                camera={focusedCamera}
                session={streamsByCamera[focusedCamera.id]}
              />
              <div className="viewport-hud-top">
                <div style={{ display: 'flex', gap: 6 }}>
                  {streamsByCamera[focusedCamera.id] ? (
                    <span className="hud-pill live-dot">LIVE</span>
                  ) : (
                    <span className="hud-pill">SNAPSHOT</span>
                  )}
                  {focusedCamera.isRecording && (
                    <span className="hud-pill rec-dot">REC MP4</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onSelectFocusCamera(null)}
                >
                  <LayoutGrid size={14} />
                  Back to Grid
                </button>
              </div>
            </div>

            <div className="theater-toolbar">
              <div>
                <h3 className="camera-title">{focusedCamera.name}</h3>
                <div className="camera-sub">
                  {focusedCamera.model} · {focusedCamera.locationName} ·{' '}
                  {formatSignalQuality(focusedCamera.rssi)}
                </div>
              </div>

              <div className="camera-actions">
                {streamsByCamera[focusedCamera.id] ? (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={Boolean(busyByCamera[focusedCamera.id])}
                    onClick={() =>
                      void runBusy(focusedCamera.id, 'stop', () =>
                        onStopStream(focusedCamera.id),
                      )
                    }
                  >
                    <Square size={13} />
                    Stop Live
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={Boolean(busyByCamera[focusedCamera.id])}
                    onClick={() =>
                      void runBusy(focusedCamera.id, 'stream', () =>
                        onStartStream(focusedCamera.id),
                      )
                    }
                  >
                    <Play size={13} />
                    {busyByCamera[focusedCamera.id] === 'stream'
                      ? 'Connecting…'
                      : 'Start Live Stream'}
                  </button>
                )}

                <select
                  aria-label="Capture clip duration"
                  className="select"
                  style={{ width: 84, padding: '5px 8px', fontSize: 12 }}
                  value={captureSeconds}
                  onChange={(e) => setCaptureSeconds(Number(e.target.value))}
                >
                  <option value={15}>15s</option>
                  <option value={30}>30s</option>
                  <option value={45}>45s</option>
                  <option value={60}>60s</option>
                </select>

                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={
                    focusedCamera.isRecording ||
                    Boolean(busyByCamera[focusedCamera.id])
                  }
                  onClick={() =>
                    void runBusy(focusedCamera.id, 'rec', () =>
                      onCaptureRecording(focusedCamera.id, captureSeconds),
                    )
                  }
                >
                  <Circle size={12} fill="#ef4444" color="#ef4444" />
                  {focusedCamera.isRecording ? 'Capturing…' : 'Capture MP4'}
                </button>

                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={Boolean(busyByCamera[focusedCamera.id])}
                  onClick={() =>
                    void runBusy(focusedCamera.id, 'snap', () =>
                      onCaptureSnapshot(focusedCamera.id),
                    )
                  }
                >
                  <Camera size={13} />
                  Snapshot
                </button>

                <button
                  type="button"
                  className="btn btn-warn btn-sm"
                  disabled={Boolean(busyByCamera[focusedCamera.id])}
                  onClick={() =>
                    void runBusy(focusedCamera.id, 'ai', () =>
                      onScanPackages(focusedCamera.id),
                    )
                  }
                >
                  <PackageSearch size={13} />
                  {busyByCamera[focusedCamera.id] === 'ai'
                    ? 'Scanning…'
                    : 'AI Package Scan'}
                </button>

                {focusedCamera.hasLight && (
                  <button
                    type="button"
                    className={`btn btn-sm ${focusedCamera.lightOn ? 'btn-warn' : ''}`}
                    onClick={() =>
                      void onToggleLight(focusedCamera.id, !focusedCamera.lightOn)
                    }
                  >
                    <Lightbulb size={13} />
                    Light {focusedCamera.lightOn ? 'On' : 'Off'}
                  </button>
                )}

                {focusedCamera.hasSiren && (
                  <button
                    type="button"
                    className={`btn btn-sm ${focusedCamera.sirenOn ? 'btn-danger' : ''}`}
                    onClick={() =>
                      void onToggleSiren(focusedCamera.id, !focusedCamera.sirenOn)
                    }
                  >
                    <Siren size={13} />
                    Siren
                  </button>
                )}
              </div>
            </div>
          </div>

          <aside className="theater-sidebar">
            <div className="panel">
              <div className="panel-header">
                <h3>Switch Camera</h3>
              </div>
              <div className="panel-body form-stack" style={{ gap: 8 }}>
                {cameras.map((cam) => (
                  <button
                    key={cam.id}
                    type="button"
                    className={`mini-cam-item ${
                      cam.id === focusedCamera.id ? 'selected' : ''
                    }`}
                    onClick={() => onSelectFocusCamera(cam.id)}
                  >
                    {cam.lastSnapshotDataUrl && (
                      <img
                        src={cam.lastSnapshotDataUrl}
                        alt={cam.name}
                        className="mini-cam-thumb"
                      />
                    )}
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
                        {cam.name}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {streamsByCamera[cam.id]
                          ? 'Streaming live'
                          : cam.online
                            ? 'Ready'
                            : 'Offline'}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </section>
      ) : null}

      {cameras.length === 0 ? (
        <div className="panel">
          <div className="empty-state">
            <Camera size={28} />
            <strong>No Ring cameras found</strong>
            <span>
              Connect your Ring account in Settings or switch to Demo Mode to test
              all features.
            </span>
          </div>
        </div>
      ) : (
        <section className="camera-grid" aria-label="Camera grid">
          {cameras.map((cam) => {
            const session = streamsByCamera[cam.id]
            const busy = busyByCamera[cam.id]
            return (
              <article key={cam.id} className="camera-card">
                <div className="camera-viewport">
                  <LiveVideoPlayer camera={cam} session={session} />
                  <div className="viewport-hud-top">
                    <div style={{ display: 'flex', gap: 6 }}>
                      {session ? (
                        <span className="hud-pill live-dot">LIVE</span>
                      ) : (
                        <span className="hud-pill">
                          {cam.online ? 'READY' : 'OFFLINE'}
                        </span>
                      )}
                      {cam.isRecording && (
                        <span className="hud-pill rec-dot">REC</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-icon"
                      style={{ background: 'rgba(9,13,19,0.75)' }}
                      onClick={() => onSelectFocusCamera(cam.id)}
                      title="Expand into Live Theater view"
                    >
                      <Maximize2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="camera-card-body">
                  <div className="camera-meta-row">
                    <div>
                      <h3 className="camera-title">{cam.name}</h3>
                      <div className="camera-sub">
                        {cam.model} · Last motion {formatRelativeTime(cam.lastMotionAt)}
                      </div>
                    </div>
                    <div className="camera-stats">
                      <span title={formatSignalQuality(cam.rssi)}>
                        <Wifi size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
                        {cam.rssi ?? 'AC'}
                      </span>
                      {cam.batteryPercent !== null && (
                        <span>
                          <Battery
                            size={12}
                            style={{ verticalAlign: -1, marginRight: 3 }}
                          />
                          {cam.batteryPercent}%
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="camera-actions">
                    {session ? (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void runBusy(cam.id, 'stop', () => onStopStream(cam.id))
                        }
                      >
                        <Square size={12} />
                        Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void runBusy(cam.id, 'stream', () =>
                            onStartStream(cam.id),
                          )
                        }
                      >
                        <Play size={12} />
                        {busy === 'stream' ? 'Starting…' : 'Live View'}
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={cam.isRecording || Boolean(busy)}
                      onClick={() =>
                        void runBusy(cam.id, 'rec', () =>
                          onCaptureRecording(cam.id, defaultCaptureSeconds),
                        )
                      }
                    >
                      <Circle size={11} fill="#ef4444" color="#ef4444" />
                      {cam.isRecording
                        ? 'Recording…'
                        : `Record ${defaultCaptureSeconds}s`}
                    </button>

                    <button
                      type="button"
                      className="btn btn-warn btn-sm"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void runBusy(cam.id, 'ai', () => onScanPackages(cam.id))
                      }
                    >
                      <PackageSearch size={13} />
                      {busy === 'ai' ? 'Scanning…' : 'Scan Packages'}
                    </button>

                    {cam.hasLight && (
                      <button
                        type="button"
                        className={`btn btn-icon ${cam.lightOn ? 'btn-warn' : ''}`}
                        onClick={() => void onToggleLight(cam.id, !cam.lightOn)}
                        title="Toggle floodlight"
                      >
                        <Lightbulb size={14} />
                      </button>
                    )}

                    {cam.hasSiren && (
                      <button
                        type="button"
                        className={`btn btn-icon ${cam.sirenOn ? 'btn-danger' : ''}`}
                        onClick={() => void onToggleSiren(cam.id, !cam.sirenOn)}
                        title="Toggle camera siren"
                      >
                        <Siren size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
        </section>
      )}
    </div>
  )
}
