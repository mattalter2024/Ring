import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Calendar,
  Camera,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  FastForward,
  Film,
  FolderOpen,
  Package,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Rewind,
  SkipBack,
  SkipForward,
  Square,
  Star,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type {
  LocalRecordingItem,
  NvrStatus,
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
  nvrStatus: NvrStatus
  nvrBusy: boolean
  defaultCaptureSeconds: number
  onToggleAllRecording: () => Promise<void>
  onSyncCloudEvents: () => Promise<void>
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
  nvrStatus,
  nvrBusy,
  defaultCaptureSeconds,
  onToggleAllRecording,
  onSyncCloudEvents,
  onCaptureRecording,
  onToggleStar,
  onExportRecording,
  onOpenInFolder,
}: TimelineViewProps) {
  const [dateKey, setDateKey] = useState<string>(() => toLocalDateKey(new Date()))
  const [zoomHours, setZoomHours] = useState<TimelineZoomHours>(6)
  const [selectedCameraId, setSelectedCameraId] = useState<string>(
    () => cameras[0]?.id ?? recordings[0]?.cameraId ?? '',
  )
  const [clipListScope, setClipListScope] = useState<'camera' | 'all'>('camera')
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
  const [syncingEvents, setSyncingEvents] = useState(false)
  const [nowMs, setNowMs] = useState<number>(() => Date.now())

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const tracksContainerRef = useRef<HTMLDivElement | null>(null)
  const pendingSeekRef = useRef<{
    clipId: string
    offsetSeconds: number
    autoPlay: boolean
  } | null>(null)

  useEffect(() => {
    if (!nvrStatus.active) return
    const timer = setInterval(() => setNowMs(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [nvrStatus.active])

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

  // Camera tracks = all configured cameras + any imported/historical recordings cameraIds
  const cameraTracks = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; snapshot?: string; model?: string }
    >()
    for (const c of cameras) {
      map.set(c.id, {
        id: c.id,
        name: c.name,
        snapshot: c.lastSnapshotDataUrl,
        model: c.model,
      })
    }
    for (const r of recordings) {
      if (!map.has(r.cameraId)) {
        map.set(r.cameraId, {
          id: r.cameraId,
          name: r.cameraName,
          snapshot: r.thumbnailDataUrl,
        })
      }
    }
    return Array.from(map.values())
  }, [cameras, recordings])

  // Keep selectedCameraId valid as cameras/recordings load
  useEffect(() => {
    if (cameraTracks.length === 0) return
    if (!selectedCameraId || !cameraTracks.some((c) => c.id === selectedCameraId)) {
      setSelectedCameraId(cameraTracks[0].id)
    }
  }, [cameraTracks, selectedCameraId])

  const activeCameraTrack = useMemo(
    () => cameraTracks.find((c) => c.id === selectedCameraId) ?? cameraTracks[0] ?? null,
    [cameraTracks, selectedCameraId],
  )

  const activeCameraRecordingsOnDay = useMemo(
    () =>
      activeCameraTrack
        ? dayRecordings.filter((r) => r.cameraId === activeCameraTrack.id)
        : dayRecordings,
    [dayRecordings, activeCameraTrack],
  )

  const latestRecordingForActiveCamera = useMemo(() => {
    if (!activeCameraTrack) return null
    const allForCam = recordings
      .filter((r) => r.cameraId === activeCameraTrack.id)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
    return allForCam[0] ?? null
  }, [recordings, activeCameraTrack])

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

  // Always show a clip belonging to the active camera when available on this day
  const activeClip = useMemo(() => {
    const exact = recordings.find((r) => r.id === activeClipId)
    if (
      exact &&
      (!activeCameraTrack || exact.cameraId === activeCameraTrack.id)
    ) {
      return exact
    }
    return activeCameraRecordingsOnDay[activeCameraRecordingsOnDay.length - 1] ?? null
  }, [recordings, activeClipId, activeCameraTrack, activeCameraRecordingsOnDay])

  const selectedEvent = useMemo(
    () => dayEvents.find((e) => e.id === selectedEventId) ?? null,
    [dayEvents, selectedEventId],
  )

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate
    }
  }, [playbackRate, activeClip?.id])

  const applySeekIfSameClip = (
    clipId: string,
    offsetSeconds: number,
    autoPlay: boolean,
  ) => {
    pendingSeekRef.current = { clipId, offsetSeconds, autoPlay }
    if (activeClip?.id === clipId && videoRef.current && videoRef.current.readyState >= 1) {
      const video = videoRef.current
      const clamped = Math.max(
        0,
        Math.min(
          offsetSeconds,
          Number.isFinite(video.duration) && video.duration > 0
            ? Math.max(0, video.duration - 0.5)
            : offsetSeconds,
        ),
      )
      try {
        video.currentTime = clamped
      } catch {
        // Metadata still settling
      }
      if (autoPlay) {
        void video.play().then(() => setIsPlaying(true)).catch(() => {})
      }
      pendingSeekRef.current = null
    }
  }

  const handleSelectCamera = (cameraId: string) => {
    setSelectedCameraId(cameraId)
    setSelectedEventId(null)

    // Try finding a clip for this camera at the current playhead first
    const atPlayhead = findClipAtTimestamp(dayRecordings, playheadMs, cameraId)
    if (atPlayhead) {
      setActiveClipId(atPlayhead.clip.id)
      applySeekIfSameClip(atPlayhead.clip.id, atPlayhead.offsetSeconds, isPlaying)
      return
    }

    // Otherwise jump to the latest clip for this camera on the selected day
    const camDayClips = dayRecordings.filter((r) => r.cameraId === cameraId)
    if (camDayClips.length > 0) {
      const latest = camDayClips[camDayClips.length - 1]
      setActiveClipId(latest.id)
      setPlayheadMs(new Date(latest.createdAt).getTime())
      applySeekIfSameClip(latest.id, 0, false)
    } else {
      setActiveClipId(null)
    }
  }

  const seekToTimestamp = (
    tsMs: number,
    preferCameraId?: string,
    options?: { keepEventId?: string | null; preRollSeconds?: number; autoPlay?: boolean },
  ) => {
    const targetCamId = preferCameraId ?? activeCameraTrack?.id
    if (preferCameraId && preferCameraId !== selectedCameraId) {
      setSelectedCameraId(preferCameraId)
    }

    const clamped = Math.max(dayStartMs, Math.min(dayEndMs - 1, tsMs))
    setPlayheadMs(clamped)

    const match = findClipAtTimestamp(dayRecordings, clamped, targetCamId)

    if (options?.keepEventId !== undefined) {
      setSelectedEventId(options.keepEventId)
    } else if (match) {
      setSelectedEventId(null)
    }

    if (match) {
      const preRoll = options?.preRollSeconds ?? 0
      const targetOffset = Math.max(0, match.offsetSeconds - preRoll)
      setActiveClipId(match.clip.id)
      applySeekIfSameClip(match.clip.id, targetOffset, Boolean(options?.autoPlay))
    }
  }

  const selectClip = (clip: LocalRecordingItem) => {
    const clipStart = new Date(clip.createdAt).getTime()
    const clipDate = toLocalDateKey(new Date(clipStart))
    if (clipDate !== dateKey) {
      setDateKey(clipDate)
    }
    setSelectedCameraId(clip.cameraId)
    setActiveClipId(clip.id)
    setSelectedEventId(null)
    setPlayheadMs(clipStart)
    applySeekIfSameClip(clip.id, 0, true)
  }

  const selectEventPin = (ev: SecurityEvent, preferCameraId?: string) => {
    const ts = new Date(ev.timestamp).getTime()
    seekToTimestamp(ts, preferCameraId ?? activeCameraTrack?.id, {
      keepEventId: ev.id,
      preRollSeconds: 3,
      autoPlay: true,
    })
  }

  const jumpStop = (direction: 'prev' | 'next') => {
    const scopedClips = activeCameraTrack
      ? activeCameraRecordingsOnDay
      : dayRecordings
    const scopedEvents = activeCameraTrack
      ? dayEvents.filter(
          (e) => e.deviceId === activeCameraTrack.id || e.sourceType === 'sensor',
        )
      : dayEvents
    const target = findNearestTimelineStop(
      scopedClips,
      scopedEvents,
      playheadMs,
      direction,
    )
    if (target !== null) {
      seekToTimestamp(target, activeCameraTrack?.id)
    }
  }

  const handleTrackPointer = (clientX: number, laneCameraId?: string) => {
    const el = tracksContainerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pct = ((clientX - rect.left) / Math.max(1, rect.width)) * 100
    const tsMs = percentToMs(pct, windowStartMs, windowEndMs)
    seekToTimestamp(tsMs, laneCameraId ?? activeCameraTrack?.id)
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
  }, [dragging, windowStartMs, windowEndMs, dayRecordings, activeCameraTrack?.id])

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
  const sensorEvents = dayEvents.filter((e) => e.sourceType === 'sensor')

  const displayedClipList =
    clipListScope === 'camera' && activeCameraTrack
      ? activeCameraRecordingsOnDay
      : dayRecordings

  const activeCameraCanRecord = Boolean(
    activeCameraTrack && cameras.some((c) => c.id === activeCameraTrack.id),
  )

  return (
    <div className="timeline-page">
      {/* Step 1: Clear Active Camera Selector Strip */}
      <section className="panel timeline-camera-bar" aria-label="Select active timeline camera">
        <div className="timeline-camera-bar-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Camera size={15} color="var(--accent-text)" />
            <strong style={{ fontSize: 13.5 }}>Active Timeline Camera</strong>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Click a camera below (or its track on the left) to switch playback &amp; scrubbing
            </span>
          </div>
          {nvrStatus.active && (
            <span className="chip alert">
              <span className="timeline-rec-dot" />
              24/7 NVR Live ({nvrStatus.activeCameraCount}/{cameras.length})
            </span>
          )}
        </div>

        <div className="timeline-camera-strip">
          {cameraTracks.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '6px 2px' }}>
              No cameras connected yet. Connect Ring in Settings to record onto the timeline.
            </div>
          ) : (
            cameraTracks.map((cam) => {
              const isSelected = activeCameraTrack?.id === cam.id
              const camClipCount = dayRecordings.filter((r) => r.cameraId === cam.id).length
              const camNvr = nvrStatus.cameras[cam.id]
              const isRec = camNvr?.state === 'recording'
              return (
                <button
                  key={cam.id}
                  type="button"
                  className={`timeline-cam-pill ${isSelected ? 'active' : ''}`}
                  onClick={() => handleSelectCamera(cam.id)}
                >
                  {cam.snapshot ? (
                    <img
                      src={cam.snapshot}
                      alt={cam.name}
                      className="timeline-cam-pill-thumb"
                    />
                  ) : (
                    <div className="timeline-cam-pill-thumb placeholder">
                      <Camera size={16} />
                    </div>
                  )}
                  <div className="timeline-cam-pill-info">
                    <div className="timeline-cam-pill-name">
                      {isRec && <span className="timeline-rec-dot" title="Recording 24/7" />}
                      <span>{cam.name}</span>
                    </div>
                    <div className="timeline-cam-pill-meta mono">
                      <span>
                        {camClipCount} clip{camClipCount === 1 ? '' : 's'} on {dateKey}
                      </span>
                      {isSelected && <span className="timeline-active-tag">VIEWING</span>}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </section>

      {/* Step 2: Active Camera Playback Monitor + Clip List */}
      <div className="timeline-stage-grid">
        <section className="panel" aria-label="Timeline video playback">
          <div className="panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3>
                {activeCameraTrack?.name ?? 'Timeline Playback Monitor'}
              </h3>
              {activeCameraTrack && (
                <span className="chip accent">Active Camera</span>
              )}
              {activeClip && (
                <span className="chip">{activeClip.trigger}</span>
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
                  onLoadedMetadata={(e) => {
                    const video = e.currentTarget
                    video.playbackRate = playbackRate
                    const pending = pendingSeekRef.current
                    if (pending && pending.clipId === activeClip.id) {
                      const target = Math.max(
                        0,
                        Math.min(
                          pending.offsetSeconds,
                          Number.isFinite(video.duration) && video.duration > 0
                            ? Math.max(0, video.duration - 0.5)
                            : pending.offsetSeconds,
                        ),
                      )
                      try {
                        video.currentTime = target
                      } catch {
                        // ignore
                      }
                      if (pending.autoPlay) {
                        void video.play().then(() => setIsPlaying(true)).catch(() => {})
                      }
                      pendingSeekRef.current = null
                    }
                  }}
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
                      const sameCamClips = dayRecordings.filter(
                        (r) => r.cameraId === activeClip.cameraId,
                      )
                      const idx = sameCamClips.findIndex(
                        (r) => r.id === activeClip.id,
                      )
                      if (idx >= 0 && idx + 1 < sameCamClips.length) {
                        selectClip(sameCamClips[idx + 1])
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
                  <strong>
                    No clips for {activeCameraTrack?.name ?? 'this camera'} on {dateKey}
                  </strong>
                  <span>
                    Select another date, switch cameras above, or start 24/7 NVR recording.
                  </span>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {latestRecordingForActiveCamera && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => selectClip(latestRecordingForActiveCamera)}
                      >
                        Jump to Latest Clip (
                        {toLocalDateKey(new Date(latestRecordingForActiveCamera.createdAt))})
                      </button>
                    )}
                    {activeCameraCanRecord && activeCameraTrack && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={capturing}
                        onClick={async () => {
                          setCapturing(true)
                          try {
                            await onCaptureRecording(
                              activeCameraTrack.id,
                              defaultCaptureSeconds,
                            )
                          } finally {
                            setCapturing(false)
                          }
                        }}
                      >
                        <Film size={13} />
                        {capturing
                          ? 'Recording…'
                          : `Capture ${defaultCaptureSeconds}s Clip`}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Transport Controls */}
            <div className="timeline-transport">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Jump to previous event or clip on active camera"
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
                  title="Jump to next event or clip on active camera"
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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

        {/* Right Side Inspector & Camera Clip List */}
        <aside className="panel">
          <div className="panel-header">
            <h3>Clips &amp; Details</h3>
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
                <span className="telemetry-label">Cam Clips</span>
                <strong className="mono">{activeCameraRecordingsOnDay.length}</strong>
              </div>
              <div className="mini-stat-box">
                <span className="telemetry-label">Day Events</span>
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
                  {formatBytes(activeClip.sizeBytes)} · Trigger: {activeClip.trigger}
                </div>
              </div>
            ) : null}

            <div className="field">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <label style={{ margin: 0 }}>Recordings List</label>
                <div className="segmented" role="group" aria-label="Filter clips list">
                  <button
                    type="button"
                    style={{ padding: '3px 8px', fontSize: 11.5 }}
                    className={clipListScope === 'camera' ? 'active' : ''}
                    onClick={() => setClipListScope('camera')}
                  >
                    Active ({activeCameraRecordingsOnDay.length})
                  </button>
                  <button
                    type="button"
                    style={{ padding: '3px 8px', fontSize: 11.5 }}
                    className={clipListScope === 'all' ? 'active' : ''}
                    onClick={() => setClipListScope('all')}
                  >
                    All ({dayRecordings.length})
                  </button>
                </div>
              </div>

              <div className="timeline-clip-list">
                {displayedClipList.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
                    {clipListScope === 'camera'
                      ? `No clips recorded for ${activeCameraTrack?.name ?? 'this camera'} on ${dateKey}.`
                      : `No local clips recorded on ${dateKey}.`}
                  </div>
                ) : (
                  displayedClipList.map((clip) => (
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                className={`btn btn-sm ${nvrStatus.active ? 'btn-danger' : 'btn-primary'}`}
                disabled={nvrBusy}
                onClick={() => void onToggleAllRecording()}
              >
                {nvrStatus.active ? (
                  <>
                    <Square size={12} fill="currentColor" />
                    Stop All-Camera NVR ({nvrStatus.activeCameraCount}/{cameras.length})
                  </>
                ) : (
                  <>
                    <Circle size={12} fill="currentColor" />
                    Record All Cameras 24/7
                  </>
                )}
              </button>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={syncingEvents}
                  onClick={async () => {
                    setSyncingEvents(true)
                    try {
                      await onSyncCloudEvents()
                    } finally {
                      setSyncingEvents(false)
                    }
                  }}
                >
                  <RefreshCw size={13} className={syncingEvents ? 'spin' : ''} />
                  {syncingEvents ? 'Syncing…' : 'Sync Events'}
                </button>

                {activeCameraCanRecord && activeCameraTrack && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={capturing}
                    title={`Record a ${defaultCaptureSeconds}s MP4 clip from ${activeCameraTrack.name}`}
                    onClick={async () => {
                      setCapturing(true)
                      try {
                        await onCaptureRecording(
                          activeCameraTrack.id,
                          defaultCaptureSeconds,
                        )
                      } finally {
                        setCapturing(false)
                      }
                    }}
                  >
                    <Film size={13} />
                    {capturing ? 'Saving…' : `Clip ${defaultCaptureSeconds}s`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Step 3: Interactive Multi-Track Scrubber */}
      <section className="panel" aria-label="Interactive multi-camera timeline">
        <div className="timeline-controls-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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

        {/* Color Legend Bar */}
        <div className="timeline-legend-bar">
          <span>
            <i className="legend-swatch continuous" />
            24/7 Continuous
          </span>
          <span>
            <i className="legend-swatch motion" />
            Motion
          </span>
          <span>
            <i className="legend-swatch ding" />
            Doorbell
          </span>
          <span>
            <i className="legend-swatch package" />
            AI Package
          </span>
          <span>
            <i className="legend-swatch sensor" />
            Sensor Event
          </span>
          <span>
            <i className="legend-swatch live" />
            Recording Now
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
            Click or drag any lane to scrub · Click a camera name to switch
          </span>
        </div>

        {/* Scrollable Ruler + Swimlanes */}
        <div className="timeline-tracks-scroll">
          <div className="timeline-grid">
            <div className="timeline-labels-col">
              <div className="timeline-ruler-corner mono">CAMERA TRACKS</div>
              {cameraTracks.map((cam) => {
                const isSelected = activeCameraTrack?.id === cam.id
                const camClipCount = dayRecordings.filter((r) => r.cameraId === cam.id).length
                const camNvr = nvrStatus.cameras[cam.id]
                const isCamRecording = camNvr?.state === 'recording'
                const isCamConnecting =
                  camNvr?.state === 'connecting' || camNvr?.state === 'reconnecting'
                return (
                  <button
                    key={cam.id}
                    type="button"
                    className={`timeline-track-label clickable ${isSelected ? 'active-track' : ''}`}
                    title={`Select ${cam.name} as active timeline camera (${camClipCount} clips)`}
                    onClick={() => handleSelectCamera(cam.id)}
                  >
                    {isCamRecording && (
                      <span
                        className="timeline-rec-dot"
                        title="Continuously recording live stream"
                      />
                    )}
                    {isCamConnecting && (
                      <span
                        className="timeline-rec-dot connecting"
                        title={`NVR ${camNvr.state}`}
                      />
                    )}
                    <span className="timeline-track-name">{cam.name}</span>
                    <span className="timeline-track-count mono">{camClipCount}</span>
                  </button>
                )
              })}
              {showSensors && (
                <div className="timeline-track-label">
                  <span className="timeline-track-name">Ring Sensors</span>
                  <span className="timeline-track-count mono">{sensorEvents.length}</span>
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
                const isSelected = activeCameraTrack?.id === cam.id
                const camClips = dayRecordings.filter((r) => r.cameraId === cam.id)
                const camEvents = dayEvents.filter((e) => e.deviceId === cam.id)
                const camPackages = dayPackageHits.filter((p) => p.cameraId === cam.id)
                const camNvr = nvrStatus.cameras[cam.id]
                const liveStartMs =
                  camNvr?.state === 'recording' && camNvr.currentSegmentStartedAt
                    ? new Date(camNvr.currentSegmentStartedAt).getTime()
                    : null
                const showLiveBar =
                  liveStartMs !== null &&
                  nowMs >= windowStartMs &&
                  liveStartMs <= windowEndMs

                return (
                  <div
                    key={cam.id}
                    className={`timeline-lane ${isSelected ? 'active-lane' : ''}`}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setDragging(true)
                      handleTrackPointer(e.clientX, cam.id)
                    }}
                  >
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

                    {showLiveBar && liveStartMs !== null && (
                      <div
                        className="timeline-live-recording-bar"
                        style={{
                          left: `${Math.max(0, msToPercent(liveStartMs, windowStartMs, windowEndMs))}%`,
                          width: `${Math.max(
                            0.8,
                            Math.min(100, msToPercent(nowMs, windowStartMs, windowEndMs)) -
                              Math.max(0, msToPercent(liveStartMs, windowStartMs, windowEndMs)),
                          )}%`,
                        }}
                        title={`${cam.name} — Recording live segment now (will appear for playback once segment rotates)`}
                      />
                    )}

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
                          title={`${ev.title} (${formatTimestamp(ev.timestamp)}) — Click to jump & play`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            selectEventPin(ev, cam.id)
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
                          title={`AI Package (${Math.round(pkg.confidence * 100)}%): ${pkg.summary} — Click to jump & play`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            seekToTimestamp(ts, cam.id, {
                              preRollSeconds: 3,
                              autoPlay: true,
                            })
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
                        title={`${ev.title} (${formatTimestamp(ev.timestamp)}) — Click to jump & play`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectEventPin(ev)
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
        </div>
      </section>
    </div>
  )
}
