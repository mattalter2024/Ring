import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Download,
  FastForward,
  Film,
  FolderOpen,
  Package,
  Pause,
  Play,
  Radio,
  Rewind,
  SkipBack,
  SkipForward,
  Star,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type {
  LocalRecordingItem,
  PackageDetectionRecord,
  RingCameraInfo,
  SecurityEvent,
} from '@shared/types'
import {
  buildRulerTicks,
  computeVisibleWindow,
  findClipAtTimestamp,
  findNearestTimelineStop,
  getDayRangeMs,
  msToPercent,
  percentToMs,
  shiftDateKey,
  toLocalDateKey,
  type TimelineZoomHours,
} from '@/utils/timeline'
import { formatBytes, formatDuration, formatTimestamp } from '@/utils/format'

interface TimelineViewProps {
  cameras: RingCameraInfo[]
  recordings: LocalRecordingItem[]
  events: SecurityEvent[]
  packageDetections: PackageDetectionRecord[]
  defaultCaptureSeconds: number
  onCaptureRecording: (cameraId: string, durationSeconds: number) => Promise<void>
  onToggleStar: (recordingId: string) => Promise<void>
  onExportRecording: (recordingId: string) => Promise<void>
  onOpenInFolder: (recordingId: string) => Promise<void>
}

const ZOOM_LEVELS: TimelineZoomHours[] = [24, 12, 6, 1]

export function TimelineView({
  cameras,
  recordings,
  events,
  packageDetections,
  defaultCaptureSeconds,
  onCaptureRecording,
  onToggleStar,
  onExportRecording,
  onOpenInFolder,
}: TimelineViewProps) {
  const [dateKey, setDateKey] = useState<string>(() => toLocalDateKey(new Date()))
  const [zoomHours, setZoomHours] = useState<TimelineZoomHours>(6)
  const [playheadMs, setPlayheadMs] = useState<number>(() => {
    if (recordings[0]) return new Date(recordings[0].createdAt).getTime()
    return Date.now()
  })
  const [activeClipId, setActiveClipId] = useState<string | null>(
    recordings[0]?.id ?? null,
  )
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState<number>(1)
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [showMotion, setShowMotion] = useState(true)
  const [showDoorbell, setShowDoorbell] = useState(true)
  const [showPackages, setShowPackages] = useState(true)
  const [showSensors, setShowSensors] = useState(true)
  const [hoverInfo, setHoverInfo] = useState<{ pct: number; tsMs: number } | null>(
    null,
  )
  const [dragging, setDragging] = useState(false)
  const [capturing, setCapturing] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const tracksContainerRef = useRef<HTMLDivElement | null>(null)

  const { startMs: dayStartMs, endMs: dayEndMs } = useMemo(
    () => getDayRangeMs(dateKey),
    [dateKey],
  )

  const dayRecordings = useMemo(
    () =>
      recordings
        .filter((r) => {
          const ts = new Date(r.createdAt).getTime()
          return ts >= dayStartMs && ts < dayEndMs
        })
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [recordings, dayStartMs, dayEndMs],
  )

  const dayEvents = useMemo(
    () =>
      events.filter((ev) => {
        const ts = new Date(ev.timestamp).getTime()
        if (ts < dayStartMs || ts >= dayEndMs) return false
        if (ev.kind === 'motion' && !showMotion) return false
        if (ev.kind === 'ding' && !showDoorbell) return false
        if (ev.kind === 'package-detected' && !showPackages) return false
        if (ev.sourceType === 'sensor' && !showSensors) return false
        return true
      }),
    [events, dayStartMs, dayEndMs, showMotion, showDoorbell, showPackages, showSensors],
  )

  const dayPackageHits = useMemo(
    () =>
      showPackages
        ? packageDetections.filter((d) => {
            if (!d.packageDetected) return false
            const ts = new Date(d.timestamp).getTime()
            return ts >= dayStartMs && ts < dayEndMs
          })
        : [],
    [packageDetections, dayStartMs, dayEndMs, showPackages],
  )

  const { windowStartMs, windowEndMs } = useMemo(
    () => computeVisibleWindow(dayStartMs, dayEndMs, playheadMs, zoomHours),
    [dayStartMs, dayEndMs, playheadMs, zoomHours],
  )

  const rulerTicks = useMemo(
    () => buildRulerTicks(windowStartMs, windowEndMs, zoomHours),
    [windowStartMs, windowEndMs, zoomHours],
  )

  const activeClip = useMemo(
    () => recordings.find((r) => r.id === activeClipId) ?? dayRecordings[0] ?? null,
    [recordings, activeClipId, dayRecordings],
  )

  const selectedEvent = useMemo(
    () => dayEvents.find((e) => e.id === selectedEventId) ?? null,
    [dayEvents, selectedEventId],
  )

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate
    }
  }, [playbackRate, activeClip?.id])

  const seekToTimestamp = (tsMs: number, preferCameraId?: string) => {
    const clamped = Math.max(dayStartMs, Math.min(dayEndMs - 1, tsMs))
    setPlayheadMs(clamped)

    const match = findClipAtTimestamp(dayRecordings, clamped, preferCameraId)
    if (match) {
      setActiveClipId(match.clip.id)
      setSelectedEventId(null)
      requestAnimationFrame(() => {
        const video = videoRef.current
        if (video && Number.isFinite(match.offsetSeconds)) {
          const target = Math.min(
            match.offsetSeconds,
            Number.isFinite(video.duration) && video.duration > 0
              ? video.duration
              : match.offsetSeconds,
          )
          try {
            video.currentTime = target
          } catch {
            // Video metadata still loading
          }
        }
      })
    }
  }

  const selectClip = (clip: LocalRecordingItem) => {
    const clipStart = new Date(clip.createdAt).getTime()
    setActiveClipId(clip.id)
    setSelectedEventId(null)
    setPlayheadMs(clipStart)
    requestAnimationFrame(() => {
      const video = videoRef.current
      if (video) {
        video.currentTime = 0
        void video.play().then(() => setIsPlaying(true)).catch(() => {})
      }
    })
  }

  const jumpStop = (direction: 'prev' | 'next') => {
    const target = findNearestTimelineStop(
      dayRecordings,
      dayEvents,
      playheadMs,
      direction,
    )
    if (target !== null) {
      seekToTimestamp(target)
    }
  }

  const handleTrackPointer = (clientX: number) => {
    const el = tracksContainerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pct = ((clientX - rect.left) / Math.max(1, rect.width)) * 100
    const tsMs = percentToMs(pct, windowStartMs, windowEndMs)
    seekToTimestamp(tsMs)
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => handleTrackPointer(e.clientX)
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, windowStartMs, windowEndMs, dayRecordings])

  const togglePlayPause = () => {
    const video = videoRef.current
    if (!video || !activeClip?.playbackUrl) return
    if (video.paused) {
      void video.play().then(() => setIsPlaying(true)).catch(() => {})
    } else {
      video.pause()
      setIsPlaying(false)
    }
  }

  const stepVideoSeconds = (delta: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, video.currentTime + delta)
  }

  const zoomIdx = ZOOM_LEVELS.indexOf(zoomHours)
  const playheadPct = msToPercent(playheadMs, windowStartMs, windowEndMs)

  // Camera tracks = all configured cameras + any imported/other recordings cameraIds
  const cameraTracks = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const c of cameras) map.set(c.id, { id: c.id, name: c.name })
    for (const r of dayRecordings) {
      if (!map.has(r.cameraId)) {
        map.set(r.cameraId, { id: r.cameraId, name: r.cameraName })
      }
    }
    return Array.from(map.values())
  }, [cameras, dayRecordings])

  const sensorEvents = dayEvents.filter((e) => e.sourceType === 'sensor')

  return (
    <div className="timeline-page">
      {/* Top Player + Inspector Row */}
      <div className="timeline-stage-grid">
        <section className="panel" aria-label="Timeline video playback">
          <div className="panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3>
                {activeClip ? activeClip.cameraName : 'Timeline Playback Monitor'}
              </h3>
              {activeClip && (
                <span className="chip accent">{activeClip.trigger}</span>
              )}
              {activeClip?.starred && (
                <span className="chip warn">
                  <Star size={11} fill="currentColor" />
                  Protected
                </span>
              )}
            </div>
            <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {new Date(playheadMs).toLocaleString()}
            </span>
          </div>

          <div className="panel-body" style={{ padding: 12 }}>
            <div className="player-video-box" style={{ maxHeight: 380 }}>
              {activeClip?.playbackUrl ? (
                <video
                  ref={videoRef}
                  key={activeClip.id}
                  src={activeClip.playbackUrl}
                  poster={activeClip.thumbnailDataUrl}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={(e) => {
                    const current = e.currentTarget.currentTime
                    const base = new Date(activeClip.createdAt).getTime()
                    setPlayheadMs(base + current * 1000)
                  }}
                  onEnded={() => {
                    setIsPlaying(false)
                    if (autoAdvance) {
                      const idx = dayRecordings.findIndex(
                        (r) => r.id === activeClip.id,
                      )
                      if (idx >= 0 && idx + 1 < dayRecordings.length) {
                        selectClip(dayRecordings[idx + 1])
                      }
                    }
                  }}
                />
              ) : activeClip?.thumbnailDataUrl ? (
                <img
                  src={activeClip.thumbnailDataUrl}
                  alt={activeClip.cameraName}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <div className="empty-state">
                  <Film size={28} />
                  <strong>No local video clip selected for {dateKey}</strong>
                  <span>
                    Click any recording bar on the timeline below or capture a new
                    local clip.
                  </span>
                </div>
              )}
            </div>

            {/* Transport Controls */}
            <div className="timeline-transport">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Jump to previous event or clip"
                  onClick={() => jumpStop('prev')}
                >
                  <SkipBack size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Rewind 5 seconds"
                  onClick={() => stepVideoSeconds(-5)}
                >
                  <Rewind size={14} />
                </button>
                <button
                  id="btn-timeline-play"
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={togglePlayPause}
                  disabled={!activeClip?.playbackUrl}
                >
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                  {isPlaying ? 'Pause' : 'Play'}
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Forward 5 seconds"
                  onClick={() => stepVideoSeconds(5)}
                >
                  <FastForward size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Jump to next event or clip"
                  onClick={() => jumpStop('next')}
                >
                  <SkipForward size={14} />
                </button>

                <select
                  aria-label="Playback speed"
                  className="select mono"
                  style={{ width: 72, padding: '4px 6px', fontSize: 12 }}
                  value={playbackRate}
                  onChange={(e) => setPlaybackRate(Number(e.target.value))}
                >
                  <option value={0.5}>0.5x</option>
                  <option value={1}>1x</option>
                  <option value={2}>2x</option>
                  <option value={4}>4x</option>
                </select>

                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    marginLeft: 6,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={autoAdvance}
                    onChange={(e) => setAutoAdvance(e.target.checked)}
                  />
                  Auto-next clip
                </label>
              </div>

              {activeClip && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${activeClip.starred ? 'btn-warn' : ''}`}
                    onClick={() => void onToggleStar(activeClip.id)}
                    title="Star/Lock clip so retention & quota pruning never deletes it"
                  >
                    <Star
                      size={13}
                      fill={activeClip.starred ? 'currentColor' : 'none'}
                    />
                    {activeClip.starred ? 'Protected' : 'Protect'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void onExportRecording(activeClip.id)}
                  >
                    <Download size={13} />
                    Export MP4
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Show in Windows Explorer"
                    onClick={() => void onOpenInFolder(activeClip.id)}
                  >
                    <FolderOpen size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right Side Inspector */}
        <aside className="panel">
          <div className="panel-header">
            <h3>Day Summary &amp; Inspector</h3>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              {dateKey}
            </span>
          </div>
          <div className="panel-body form-stack">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 8,
              }}
            >
              <div className="mini-stat-box">
                <span className="telemetry-label">Clips</span>
                <strong className="mono">{dayRecordings.length}</strong>
              </div>
              <div className="mini-stat-box">
                <span className="telemetry-label">Events</span>
                <strong className="mono">{dayEvents.length}</strong>
              </div>
              <div className="mini-stat-box">
                <span className="telemetry-label">Packages</span>
                <strong className="mono">{dayPackageHits.length}</strong>
              </div>
            </div>

            {selectedEvent ? (
              <div className="inspector-box">
                <span className="chip warn">{selectedEvent.kind}</span>
                <strong style={{ marginTop: 6, display: 'block' }}>
                  {selectedEvent.title}
                </strong>
                <p style={{ margin: '4px 0', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  {selectedEvent.detail}
                </p>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {formatTimestamp(selectedEvent.timestamp)} · {selectedEvent.deviceName}
                </span>
              </div>
            ) : activeClip ? (
              <div className="inspector-box">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                  <strong>{activeClip.cameraName}</strong>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {formatDuration(activeClip.durationSeconds)}
                  </span>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-muted)',
                    marginTop: 4,
                    wordBreak: 'break-all',
                  }}
                >
                  {activeClip.fileName}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                  Stored locally · {formatBytes(activeClip.sizeBytes)} · Trigger:{' '}
                  {activeClip.trigger}
                </div>
              </div>
            ) : null}

            <div className="field">
              <label>Clips on {dateKey}</label>
              <div className="timeline-clip-list">
                {dayRecordings.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
                    No local clips recorded on this date.
                  </div>
                ) : (
                  dayRecordings.map((clip) => (
                    <button
                      key={clip.id}
                      type="button"
                      className={`mini-cam-item ${
                        activeClip?.id === clip.id ? 'selected' : ''
                      }`}
                      onClick={() => selectClip(clip)}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 12.5,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {clip.cameraName}
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {formatTimestamp(clip.createdAt)} · {formatDuration(clip.durationSeconds)}
                        </div>
                      </div>
                      <span className="chip">{clip.trigger}</span>
                    </button>
                  ))
                )}
              </div>
            </div>

            {cameras[0] && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={capturing}
                onClick={async () => {
                  setCapturing(true)
                  try {
                    await onCaptureRecording(cameras[0].id, defaultCaptureSeconds)
                  } finally {
                    setCapturing(false)
                  }
                }}
              >
                <Film size={13} />
                {capturing ? 'Capturing MP4…' : `Record ${cameras[0].name}`}
              </button>
            )}
          </div>
        </aside>
      </div>

      {/* Interactive Multi-Track Scrubber */}
      <section className="panel" aria-label="Interactive multi-camera timeline">
        <div className="timeline-controls-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="btn btn-icon"
              title="Previous day"
              onClick={() => {
                const nextDate = shiftDateKey(dateKey, -1)
                setDateKey(nextDate)
                setPlayheadMs(getDayRangeMs(nextDate).startMs + 12 * 3600 * 1000)
              }}
            >
              <ChevronLeft size={15} />
            </button>

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Calendar
                size={13}
                style={{ position: 'absolute', left: 9, color: 'var(--text-muted)', pointerEvents: 'none' }}
              />
              <input
                aria-label="Timeline date"
                type="date"
                className="input mono"
                style={{ paddingLeft: 28, paddingTop: 5, paddingBottom: 5, fontSize: 12.5, width: 148 }}
                value={dateKey}
                onChange={(e) => {
                  if (!e.target.value) return
                  setDateKey(e.target.value)
                  setPlayheadMs(getDayRangeMs(e.target.value).startMs + 12 * 3600 * 1000)
                }}
              />
            </div>

            <button
              type="button"
              className="btn btn-icon"
              title="Next day"
              onClick={() => {
                const nextDate = shiftDateKey(dateKey, 1)
                setDateKey(nextDate)
                setPlayheadMs(getDayRangeMs(nextDate).startMs + 12 * 3600 * 1000)
              }}
            >
              <ChevronRight size={15} />
            </button>

            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const today = toLocalDateKey(new Date())
                setDateKey(today)
                setPlayheadMs(Date.now())
              }}
            >
              Today
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn btn-sm ${showMotion ? 'btn-warn' : ''}`}
              onClick={() => setShowMotion((v) => !v)}
            >
              Motion
            </button>
            <button
              type="button"
              className={`btn btn-sm ${showDoorbell ? 'btn-danger' : ''}`}
              onClick={() => setShowDoorbell((v) => !v)}
            >
              Doorbell
            </button>
            <button
              type="button"
              className={`btn btn-sm ${showPackages ? 'btn-primary' : ''}`}
              onClick={() => setShowPackages((v) => !v)}
            >
              <Package size={12} />
              AI Packages
            </button>
            <button
              type="button"
              className={`btn btn-sm ${showSensors ? 'btn-primary' : ''}`}
              onClick={() => setShowSensors((v) => !v)}
            >
              <Radio size={12} />
              Sensors
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="btn btn-icon"
              title="Zoom out"
              disabled={zoomIdx <= 0}
              onClick={() => setZoomHours(ZOOM_LEVELS[Math.max(0, zoomIdx - 1)])}
            >
              <ZoomOut size={14} />
            </button>
            <div className="segmented" role="group" aria-label="Timeline zoom">
              {ZOOM_LEVELS.map((hrs) => (
                <button
                  key={hrs}
                  type="button"
                  className={zoomHours === hrs ? 'active' : ''}
                  onClick={() => setZoomHours(hrs)}
                >
                  {hrs}h
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-icon"
              title="Zoom in"
              disabled={zoomIdx >= ZOOM_LEVELS.length - 1}
              onClick={() =>
                setZoomHours(
                  ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, zoomIdx + 1)],
                )
              }
            >
              <ZoomIn size={14} />
            </button>
          </div>
        </div>

        {/* Ruler + Swimlanes */}
        <div className="timeline-grid">
          <div className="timeline-labels-col">
            <div className="timeline-ruler-corner mono">TRACKS</div>
            {cameraTracks.map((cam) => (
              <div key={cam.id} className="timeline-track-label" title={cam.name}>
                <span>{cam.name}</span>
              </div>
            ))}
            {showSensors && (
              <div className="timeline-track-label">
                <span>Ring Sensors</span>
              </div>
            )}
          </div>

          <div
            ref={tracksContainerRef}
            className="timeline-lanes-col"
            onMouseDown={(e) => {
              setDragging(true)
              handleTrackPointer(e.clientX)
            }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pct = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100
              setHoverInfo({
                pct: Math.max(0, Math.min(100, pct)),
                tsMs: percentToMs(pct, windowStartMs, windowEndMs),
              })
            }}
            onMouseLeave={() => setHoverInfo(null)}
          >
            {/* Time Ruler */}
            <div className="timeline-ruler">
              {rulerTicks.map((tick) => (
                <div
                  key={tick.ms}
                  className={`timeline-tick ${tick.major ? 'major' : ''}`}
                  style={{ left: `${tick.pct}%` }}
                >
                  <span>{tick.label}</span>
                </div>
              ))}
            </div>

            {/* Camera Tracks */}
            {cameraTracks.map((cam) => {
              const camClips = dayRecordings.filter((r) => r.cameraId === cam.id)
              const camEvents = dayEvents.filter((e) => e.deviceId === cam.id)
              const camPackages = dayPackageHits.filter((p) => p.cameraId === cam.id)

              return (
                <div key={cam.id} className="timeline-lane">
                  {camClips.map((clip) => {
                    const start = new Date(clip.createdAt).getTime()
                    const end = start + Math.max(15, clip.durationSeconds) * 1000
                    if (end < windowStartMs || start > windowEndMs) return null
                    const leftPct = Math.max(
                      0,
                      msToPercent(start, windowStartMs, windowEndMs),
                    )
                    const rightPct = Math.min(
                      100,
                      msToPercent(end, windowStartMs, windowEndMs),
                    )
                    const widthPct = Math.max(1.1, rightPct - leftPct)

                    return (
                      <button
                        key={clip.id}
                        type="button"
                        className={`timeline-clip-bar trigger-${clip.trigger} ${
                          activeClip?.id === clip.id ? 'active' : ''
                        }`}
                        style={{
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                        }}
                        title={`${clip.cameraName} · ${formatTimestamp(clip.createdAt)} (${formatDuration(clip.durationSeconds)}) [${clip.trigger}]`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectClip(clip)
                        }}
                      />
                    )
                  })}

                  {camEvents.map((ev) => {
                    const ts = new Date(ev.timestamp).getTime()
                    if (ts < windowStartMs || ts > windowEndMs) return null
                    const pct = msToPercent(ts, windowStartMs, windowEndMs)
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        className={`timeline-pin pin-${ev.kind}`}
                        style={{ left: `${pct}%` }}
                        title={`${ev.title} (${formatTimestamp(ev.timestamp)})`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedEventId(ev.id)
                          setPlayheadMs(ts)
                        }}
                      />
                    )
                  })}

                  {camPackages.map((pkg) => {
                    const ts = new Date(pkg.timestamp).getTime()
                    if (ts < windowStartMs || ts > windowEndMs) return null
                    const pct = msToPercent(ts, windowStartMs, windowEndMs)
                    return (
                      <button
                        key={pkg.id}
                        type="button"
                        className="timeline-pin pin-package-detected"
                        style={{ left: `${pct}%` }}
                        title={`AI Package (${Math.round(pkg.confidence * 100)}%): ${pkg.summary}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          seekToTimestamp(ts, cam.id)
                        }}
                      />
                    )
                  })}
                </div>
              )
            })}

            {/* Dedicated Sensors Swimlane */}
            {showSensors && (
              <div className="timeline-lane">
                {sensorEvents.map((ev) => {
                  const ts = new Date(ev.timestamp).getTime()
                  if (ts < windowStartMs || ts > windowEndMs) return null
                  const pct = msToPercent(ts, windowStartMs, windowEndMs)
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      className="timeline-pin pin-sensor"
                      style={{ left: `${pct}%` }}
                      title={`${ev.title} (${formatTimestamp(ev.timestamp)})`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedEventId(ev.id)
                        setPlayheadMs(ts)
                      }}
                    />
                  )
                })}
              </div>
            )}

            {/* Hover Ghost Line + Tooltip */}
            {hoverInfo && (
              <div
                className="timeline-hover-line"
                style={{ left: `${hoverInfo.pct}%` }}
              >
                <span className="timeline-hover-badge mono">
                  {formatTimestamp(new Date(hoverInfo.tsMs).toISOString())}
                </span>
              </div>
            )}

            {/* Playhead Needle */}
            {playheadPct >= 0 && playheadPct <= 100 && (
              <div
                className="timeline-playhead"
                style={{ left: `${playheadPct}%` }}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
