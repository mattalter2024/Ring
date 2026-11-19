import { useState } from 'react'
import {
  Battery,
  Camera,
  Circle,
  Clock,
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
  NvrStatus,
  PackageDetectionRecord,
  RingCameraInfo,
} from '@shared/types'
import { formatRelativeTime, formatSignalQuality } from '@/utils/format'
import { LiveVideoPlayer } from './LiveVideoPlayer'

interface CamerasViewProps {
  cameras: RingCameraInfo[]
  streamsByCamera: Record<string, LiveStreamSession>
  connectingCameraIds: Record<string, boolean>
  autoLiveEnabled: boolean
  nvrStatus: NvrStatus
  nvrBusy: boolean
  recordingsCount: number
  packageDetections: PackageDetectionRecord[]
  defaultCaptureSeconds: number
  focusedCameraId: string | null
  onSelectFocusCamera: (cameraId: string | null) => void
  onToggleAutoLive: (enabled: boolean) => void
  onStartAllLive: () => Promise<void>
  onStopAllLive: () => Promise<void>
  onStartStream: (cameraId: string) => Promise<void>
  onStopStream: (cameraId: string) => Promise<void>
  onCaptureRecording: (cameraId: string, durationSeconds: number) => Promise<void>
  onToggleAllRecording: () => Promise<void>
  onToggleCameraContinuous: (cameraId: string, enable: boolean) => Promise<void>
  onOpenTimeline: () => void
  onCaptureSnapshot: (cameraId: string) => Promise<void>
  onScanPackages: (cameraId: string) => Promise<void>
  onToggleLight: (cameraId: string, on: boolean) => Promise<void>
  onToggleSiren: (cameraId: string, on: boolean) => Promise<void>
}

export function CamerasView({
  cameras,
  streamsByCamera,
  connectingCameraIds,
  autoLiveEnabled,
  nvrStatus,
  nvrBusy,
  recordingsCount,
  packageDetections,
  defaultCaptureSeconds,
  focusedCameraId,
  onSelectFocusCamera,
  onToggleAutoLive,
  onStartAllLive,
  onStopAllLive,
  onStartStream,
  onStopStream,
  onCaptureRecording,
  onToggleAllRecording,
  onToggleCameraContinuous,
  onOpenTimeline,
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
          <span className="telemetry-label">Live Feeds</span>
          <span className="telemetry-value">
            {liveCount}/{onlineCount}
          </span>
          <span className="telemetry-note">
            {liveCount > 0 ? 'Streaming live video' : `${onlineCount} camera(s) online`}
          </span>
        </div>
        <div className="telemetry-card">
          <span className="telemetry-label">Continuous NVR</span>
          <span
            className="telemetry-value"
            style={{ color: nvrStatus.active ? 'var(--text-alert)' : undefined }}
          >
            {nvrStatus.activeCameraCount}/{cameras.length}
          </span>
          <span className="telemetry-note">
            {nvrStatus.active
              ? `${nvrStatus.totalSegmentsCaptured} rolling MP4 segment(s) saved`
              : 'All-camera timeline recorder idle'}
          </span>
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

      {cameras.length > 0 && (
        <section className="panel nvr-banner" aria-label="Live wall and all-camera NVR controls">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className={`chip ${liveCount > 0 ? 'ok' : ''}`}>
              <Circle
                size={8}
                fill="currentColor"
              />
              {liveCount > 0 ? `${liveCount}/${cameras.length} LIVE` : 'CONNECTING LIVE'}
            </span>
            <span className={`chip ${nvrStatus.active ? 'alert' : ''}`}>
              <Circle
                size={9}
                fill={nvrStatus.active ? '#ef4444' : 'currentColor'}
                color={nvrStatus.active ? '#ef4444' : 'currentColor'}
              />
              {nvrStatus.active ? '24/7 NVR RECORDING' : 'NVR STANDBY'}
            </span>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              {nvrStatus.active ? (
                <>
                  Recording <strong>{nvrStatus.activeCameraCount}/{cameras.length}</strong>{' '}
                  camera(s) in {Math.round((nvrStatus.segmentSeconds / 60) * 10) / 10}m segments
                  — Live Wall shares the same NVR feed with zero extra Ring connection.
                </>
              ) : (
                <>
                  Cameras stream live automatically while you view this page. Enable{' '}
                  <strong>Record All Cameras</strong> for 24/7 Timeline coverage.
                </>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
            <button
              type="button"
              className={`btn btn-sm ${autoLiveEnabled ? 'btn-primary' : ''}`}
              onClick={() => onToggleAutoLive(!autoLiveEnabled)}
              title="Automatically keep all cameras streaming live while on Live Cameras"
            >
              Auto-Live: {autoLiveEnabled ? 'ON' : 'OFF'}
            </button>
            {liveCount < onlineCount ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void onStartAllLive()}
              >
                <Play size={12} />
                Stream All Live
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void onStopAllLive()}
              >
                <Square size={11} />
                Pause All Live
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={onOpenTimeline}
            >
              <Clock size={13} />
              Open Timeline
            </button>
            <button
              type="button"
              className={`btn btn-sm ${nvrStatus.active ? 'btn-danger' : 'btn-primary'}`}
              disabled={nvrBusy}
              onClick={() => void onToggleAllRecording()}
            >
              {nvrStatus.active ? (
                <>
                  <Square size={12} fill="currentColor" />
                  {nvrBusy ? 'Stopping…' : 'Stop All Recording'}
                </>
              ) : (
                <>
                  <Circle size={11} fill="#ef4444" color="#ef4444" />
                  {nvrBusy ? 'Starting…' : 'Record All Cameras'}
                </>
              )}
            </button>
          </div>
        </section>
      )}

      {focusedCamera ? (
        <section className="theater-layout" aria-label="Focused camera live view">
          <div className="theater-stage">
            <div className="camera-viewport">
              <LiveVideoPlayer
                camera={focusedCamera}
                session={streamsByCamera[focusedCamera.id]}
                isConnecting={Boolean(connectingCameraIds[focusedCamera.id])}
              />
              <div className="viewport-hud-top">
                <div style={{ display: 'flex', gap: 6 }}>
                  {streamsByCamera[focusedCamera.id] ? (
                    <span className="hud-pill live-dot">LIVE</span>
                  ) : connectingCameraIds[focusedCamera.id] ? (
                    <span className="hud-pill">CONNECTING…</span>
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
            const isConnecting = Boolean(connectingCameraIds[cam.id] || busy === 'stream')
            const camNvr = nvrStatus.cameras[cam.id]
            const isNvrOn = Boolean(
              camNvr &&
                (camNvr.state === 'recording' ||
                  camNvr.state === 'connecting' ||
                  camNvr.state === 'reconnecting'),
            )
            return (
              <article key={cam.id} className="camera-card">
                <div className="camera-viewport">
                  <LiveVideoPlayer
                    camera={cam}
                    session={session}
                    isConnecting={isConnecting}
                  />
                  <div className="viewport-hud-top">
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {session ? (
                        <span className="hud-pill live-dot">LIVE</span>
                      ) : isConnecting ? (
                        <span className="hud-pill">CONNECTING…</span>
                      ) : (
                        <span className="hud-pill">
                          {cam.online ? 'PAUSED' : 'OFFLINE'}
                        </span>
                      )}
                      {isNvrOn ? (
                        <span
                          className="hud-pill rec-dot"
                          title={camNvr?.lastError ?? 'Continuous NVR recording active'}
                        >
                          {camNvr?.state === 'connecting'
                            ? 'NVR SYNC…'
                            : camNvr?.state === 'reconnecting'
                              ? 'NVR RETRY'
                              : `NVR REC${camNvr?.segmentsCaptured ? ` (${camNvr.segmentsCaptured})` : ''}`}
                        </span>
                      ) : cam.isRecording ? (
                        <span className="hud-pill rec-dot">REC</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn btn-icon"
                      style={{ background: 'rgba(9,13,19,0.75)', color: '#edf2f7', borderColor: 'rgba(255,255,255,0.16)' }}
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
                      {camNvr?.lastError && isNvrOn && (
                        <div style={{ fontSize: 11, color: 'var(--text-warn)', marginTop: 2 }}>
                          {camNvr.lastError}
                        </div>
                      )}
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
                        disabled={Boolean(busy) || isConnecting}
                        onClick={() =>
                          void runBusy(cam.id, 'stream', () =>
                            onStartStream(cam.id),
                          )
                        }
                      >
                        <Play size={12} />
                        {isConnecting ? 'Connecting…' : 'Go Live'}
                      </button>
                    )}

                    <button
                      type="button"
                      className={`btn btn-sm ${isNvrOn ? 'btn-danger' : ''}`}
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void runBusy(cam.id, 'nvr', () =>
                          onToggleCameraContinuous(cam.id, !isNvrOn),
                        )
                      }
                      title={
                        isNvrOn
                          ? 'Stop continuous NVR recording for this camera'
                          : 'Start continuous rolling MP4 recording for this camera'
                      }
                    >
                      {isNvrOn ? (
                        <>
                          <Square size={11} fill="currentColor" />
                          Stop NVR
                        </>
                      ) : (
                        <>
                          <Circle size={11} fill="#ef4444" color="#ef4444" />
                          {busy === 'nvr' ? 'Starting…' : 'Continuous'}
                        </>
                      )}
                    </button>

                    {!isNvrOn && (
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
                        {cam.isRecording
                          ? 'Capturing…'
                          : `Clip ${defaultCaptureSeconds}s`}
                      </button>
                    )}

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
