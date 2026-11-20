import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Calendar,
  Camera,
  ChevronLeft,
  ChevronRight,
  Crosshair,
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
  computeZoomedWindowCenter,
  findClipAtTimestamp,
  findNearestTimelineStop,
  formatZoomLabel,
  getDayRangeMs,
  msToPercent,
  panWindowCenter,
  percentToMs,
  shiftDateKey,
  toLocalDateKey,
  type TimelineZoomHours,
} from '@/utils/timeline'
import { formatBytes, formatDuration, formatTimestamp } from '@/utils/format'
import { getPlatformLabels } from '@/utils/platform'

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

const ZOOM_LEVELS: TimelineZoomHours[] = [24, 12, 6, 1, 0.5, 0.25]

function formatClipClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export function TimelineView({
  cameras,
  recordings,
  events,
  packageDetections,
  nvrStatus,
  defaultCaptureSeconds,
  onSyncCloudEvents,
  onCaptureRecording,
  onToggleStar,
  onExportRecording,
  onOpenInFolder,
}: TimelineViewProps) {
  const platformLabels = useMemo(() => getPlatformLabels(), [])
  const initialAnchorMs = useMemo(
    () => (recordings[0] ? new Date(recordings[0].createdAt).getTime() : Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const [dateKey, setDateKey] = useState<string>(() =>
    toLocalDateKey(new Date(initialAnchorMs)),
  )
  const [zoomHours, setZoomHours] = useState<TimelineZoomHours>(1)
  const [viewportCenterMs, setViewportCenterMs] = useState<number>(initialAnchorMs)
  const [selectedCameraId, setSelectedCameraId] = useState<string>(
    () => cameras[0]?.id ?? recordings[0]?.cameraId ?? '',
  )
  const [clipListScope, setClipListScope] = useState<'camera' | 'all'>('camera')
  const [playheadMs, setPlayheadMs] = useState<number>(initialAnchorMs)
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
  const [dragging, setDragging] = useState(false)
  const [clipDurationSec, setClipDurationSec] = useState<number>(
    recordings[0]?.durationSeconds ?? 0,
  )
  const [clipCurrentSec, setClipCurrentSec] = useState<number>(0)
  const [capturing, setCapturing] = useState(false)
  const [syncingEvents, setSyncingEvents] = useState(false)
  const [nowMs, setNowMs] = useState<number>(() => Date.now())

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const tracksContainerRef = useRef<HTMLDivElement | null>(null)
  const playheadElRef = useRef<HTMLDivElement | null>(null)
  const hoverLineRef = useRef<HTMLDivElement | null>(null)
  const hoverBadgeRef = useRef<HTMLSpanElement | null>(null)
  const clipScrubTrackRef = useRef<HTMLDivElement | null>(null)
  const clipScrubFillRef = useRef<HTMLDivElement | null>(null)
  const clipScrubThumbRef = useRef<HTMLDivElement | null>(null)
  const clipCurrentTimeLabelRef = useRef<HTMLSpanElement | null>(null)

  const pendingSeekRef = useRef<{
    clipId: string
    offsetSeconds: number
    autoPlay: boolean
  } | null>(null)
  const queuedSeekRef = useRef<{
    clipId: string
    offsetSeconds: number
    exact: boolean
  } | null>(null)

  const isDraggingRef = useRef(false)
  const isClipBarDraggingRef = useRef(false)
  const dragCameraIdRef = useRef<string | undefined>(undefined)
  const wasPlayingBeforeDragRef = useRef(false)
  const lastDragClientXRef = useRef(0)
  const lastDragTsMsRef = useRef(initialAnchorMs)
  const dragRafRef = useRef<number | null>(null)
  const clipSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastReactSyncRef = useRef(0)

  const [clipListLimit, setClipListLimit] = useState(80)

  useEffect(() => {
    setClipListLimit(80)
  }, [dateKey, selectedCameraId, clipListScope])

  useEffect(() => {
    if (!nvrStatus.active) return
    const timer = setInterval(() => {
      if (!document.hidden && dateKey === toLocalDateKey(new Date())) {
        setNowMs(Date.now())
      }
    }, 15_000)
    return () => clearInterval(timer)
  }, [nvrStatus.active, dateKey])

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

  // Decoupled from playheadMs so the timeline stays stationary under your cursor while scrubbing!
  const { windowStartMs, windowEndMs } = useMemo(
    () => computeVisibleWindow(dayStartMs, dayEndMs, viewportCenterMs, zoomHours),
    [dayStartMs, dayEndMs, viewportCenterMs, zoomHours],
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

  // Live refs so high-frequency pointer/wheel/RAF callbacks read fresh values with zero listener churn
  const windowRef = useRef({
    windowStartMs,
    windowEndMs,
    dayStartMs,
    dayEndMs,
    zoomHours,
    viewportCenterMs,
  })
  windowRef.current = {
    windowStartMs,
    windowEndMs,
    dayStartMs,
    dayEndMs,
    zoomHours,
    viewportCenterMs,
  }
  const activeClipRef = useRef(activeClip)
  activeClipRef.current = activeClip
  const dayRecordingsRef = useRef(dayRecordings)
  dayRecordingsRef.current = dayRecordings
  const activeCameraIdRef = useRef(activeCameraTrack?.id)
  activeCameraIdRef.current = activeCameraTrack?.id

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate
    }
  }, [playbackRate, activeClip?.id])

  useEffect(() => {
    setClipDurationSec(activeClip?.durationSeconds ?? 0)
    setClipCurrentSec(0)
  }, [activeClip?.id, activeClip?.durationSeconds])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (dragRafRef.current !== null) cancelAnimationFrame(dragRafRef.current)
      if (clipSwitchTimerRef.current !== null) clearTimeout(clipSwitchTimerRef.current)
    }
  }, [])

  const syncPlayheadDom = useCallback((tsMs: number) => {
    const el = playheadElRef.current
    if (!el) return
    const { windowStartMs: ws, windowEndMs: we } = windowRef.current
    const pct = msToPercent(tsMs, ws, we)
    if (pct >= 0 && pct <= 100) {
      el.style.left = `${pct}%`
      el.style.opacity = '1'
    } else {
      el.style.opacity = '0'
    }
  }, [])

  const syncClipBarDom = useCallback((currentSec: number, durationSec: number) => {
    const pct = durationSec > 0 ? Math.max(0, Math.min(100, (currentSec / durationSec) * 100)) : 0
    if (clipScrubFillRef.current) {
      clipScrubFillRef.current.style.width = `${pct}%`
    }
    if (clipScrubThumbRef.current) {
      clipScrubThumbRef.current.style.left = `${pct}%`
    }
    if (clipCurrentTimeLabelRef.current) {
      clipCurrentTimeLabelRef.current.textContent = formatClipClock(currentSec)
    }
  }, [])

  const ensureTimestampInView = useCallback((tsMs: number) => {
    const { windowStartMs: ws, windowEndMs: we } = windowRef.current
    if (tsMs < ws || tsMs > we) {
      setViewportCenterMs(tsMs)
    }
  }, [])

  // Seek-in-flight coalescing so Chromium's H.264 decoder never backs up during fast drags
  const applyVideoSeek = useCallback(
    (
      clipId: string,
      offsetSeconds: number,
      options?: { exact?: boolean; autoPlay?: boolean },
    ) => {
      const exact = options?.exact ?? true
      const autoPlay = Boolean(options?.autoPlay)
      const currentClip = activeClipRef.current
      const video = videoRef.current

      if (!currentClip || currentClip.id !== clipId || !video || video.readyState < 1) {
        pendingSeekRef.current = { clipId, offsetSeconds, autoPlay }
        return
      }

      const maxTime =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.max(0, video.duration - 0.15)
          : offsetSeconds
      const clamped = Math.max(0, Math.min(offsetSeconds, maxTime))

      syncClipBarDom(clamped, Number.isFinite(video.duration) && video.duration > 0 ? video.duration : currentClip.durationSeconds)

      if (video.seeking && !exact) {
        queuedSeekRef.current = { clipId, offsetSeconds: clamped, exact: false }
        return
      }

      queuedSeekRef.current = null
      try {
        if (
          !exact &&
          typeof video.fastSeek === 'function' &&
          Math.abs(video.currentTime - clamped) > 0.45
        ) {
          video.fastSeek(clamped)
        } else {
          video.currentTime = clamped
        }
      } catch {
        // Metadata still settling
      }

      if (autoPlay) {
        void video.play().then(() => setIsPlaying(true)).catch(() => {})
      }
      pendingSeekRef.current = null
    },
    [syncClipBarDom],
  )

  const handleVideoSeeked = useCallback(() => {
    const queued = queuedSeekRef.current
    if (!queued) return
    queuedSeekRef.current = null
    applyVideoSeek(queued.clipId, queued.offsetSeconds, { exact: queued.exact })
  }, [applyVideoSeek])

  // 60fps smooth playhead glide during normal playback
  useEffect(() => {
    if (!isPlaying || dragging || !activeClip?.playbackUrl) return
    let rafId = 0
    const clipStartMs = new Date(activeClip.createdAt).getTime()

    const tick = () => {
      const video = videoRef.current
      if (video && !video.paused && !isDraggingRef.current && !isClipBarDraggingRef.current) {
        const current = video.currentTime
        const dur =
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : activeClip.durationSeconds
        const liveMs = clipStartMs + current * 1000
        syncPlayheadDom(liveMs)
        syncClipBarDom(current, dur)

        const now = performance.now()
        if (now - lastReactSyncRef.current > 90) {
          lastReactSyncRef.current = now
          setPlayheadMs(liveMs)
          setClipCurrentSec(current)
          const { windowEndMs: we, zoomHours: zh, dayStartMs: ds, dayEndMs: de, viewportCenterMs: vc } =
            windowRef.current
          if (liveMs > we && zh < 24) {
            setViewportCenterMs(
              panWindowCenter(ds, de, vc, zh, zh * 3600 * 1000 * 0.65),
            )
          }
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isPlaying, dragging, activeClip, syncPlayheadDom, syncClipBarDom])

  const handleSelectCamera = (cameraId: string) => {
    setSelectedCameraId(cameraId)
    setSelectedEventId(null)

    const atPlayhead = findClipAtTimestamp(dayRecordings, playheadMs, cameraId)
    if (atPlayhead) {
      setActiveClipId(atPlayhead.clip.id)
      applyVideoSeek(atPlayhead.clip.id, atPlayhead.offsetSeconds, {
        exact: true,
        autoPlay: isPlaying,
      })
      return
    }

    const camDayClips = dayRecordings.filter((r) => r.cameraId === cameraId)
    if (camDayClips.length > 0) {
      const latest = camDayClips[camDayClips.length - 1]
      const latestMs = new Date(latest.createdAt).getTime()
      setActiveClipId(latest.id)
      setPlayheadMs(latestMs)
      ensureTimestampInView(latestMs)
      applyVideoSeek(latest.id, 0, { exact: true, autoPlay: false })
    } else {
      setActiveClipId(null)
    }
  }

  const seekToTimestamp = useCallback(
    (
      tsMs: number,
      preferCameraId?: string,
      options?: {
        keepEventId?: string | null
        preRollSeconds?: number
        autoPlay?: boolean
        isDrag?: boolean
        centerIfOutOfView?: boolean
      },
    ) => {
      const { dayStartMs: ds, dayEndMs: de } = windowRef.current
      const targetCamId = preferCameraId ?? activeCameraIdRef.current
      if (preferCameraId && preferCameraId !== activeCameraIdRef.current) {
        setSelectedCameraId(preferCameraId)
      }

      const clamped = Math.max(ds, Math.min(de - 1, tsMs))
      lastDragTsMsRef.current = clamped
      syncPlayheadDom(clamped)

      if (options?.centerIfOutOfView) {
        ensureTimestampInView(clamped)
      }

      const now = performance.now()
      if (!options?.isDrag || now - lastReactSyncRef.current > 45) {
        lastReactSyncRef.current = now
        setPlayheadMs(clamped)
      }

      const match = findClipAtTimestamp(dayRecordingsRef.current, clamped, targetCamId)

      if (options?.keepEventId !== undefined) {
        setSelectedEventId(options.keepEventId)
      } else if (match && !options?.isDrag) {
        setSelectedEventId(null)
      }

      if (match) {
        const preRoll = options?.preRollSeconds ?? 0
        const targetOffset = Math.max(0, match.offsetSeconds - preRoll)

        if (activeClipRef.current?.id === match.clip.id) {
          if (clipSwitchTimerRef.current !== null) {
            clearTimeout(clipSwitchTimerRef.current)
            clipSwitchTimerRef.current = null
          }
          applyVideoSeek(match.clip.id, targetOffset, {
            exact: !options?.isDrag,
            autoPlay: Boolean(options?.autoPlay),
          })
        } else if (options?.isDrag) {
          // Debounce switching <video> sources during rapid sweeps across multiple clips
          pendingSeekRef.current = {
            clipId: match.clip.id,
            offsetSeconds: targetOffset,
            autoPlay: false,
          }
          if (clipSwitchTimerRef.current !== null) {
            clearTimeout(clipSwitchTimerRef.current)
          }
          clipSwitchTimerRef.current = setTimeout(() => {
            clipSwitchTimerRef.current = null
            setActiveClipId(match.clip.id)
          }, 95)
        } else {
          if (clipSwitchTimerRef.current !== null) {
            clearTimeout(clipSwitchTimerRef.current)
            clipSwitchTimerRef.current = null
          }
          pendingSeekRef.current = {
            clipId: match.clip.id,
            offsetSeconds: targetOffset,
            autoPlay: Boolean(options?.autoPlay),
          }
          setActiveClipId(match.clip.id)
          applyVideoSeek(match.clip.id, targetOffset, {
            exact: true,
            autoPlay: Boolean(options?.autoPlay),
          })
        }
      }
    },
    [applyVideoSeek, ensureTimestampInView, syncPlayheadDom],
  )

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
    setViewportCenterMs(clipStart)
    applyVideoSeek(clip.id, 0, { exact: true, autoPlay: true })
  }

  const selectEventPin = (ev: SecurityEvent, preferCameraId?: string) => {
    const ts = new Date(ev.timestamp).getTime()
    seekToTimestamp(ts, preferCameraId ?? activeCameraTrack?.id, {
      keepEventId: ev.id,
      preRollSeconds: 3,
      autoPlay: true,
      centerIfOutOfView: true,
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
      seekToTimestamp(target, activeCameraTrack?.id, { centerIfOutOfView: true })
    }
  }

  // Zero-rerender hover indicator update directly via DOM refs
  const updateHoverIndicator = useCallback((clientX: number | null) => {
    const line = hoverLineRef.current
    const badge = hoverBadgeRef.current
    const container = tracksContainerRef.current
    if (!line || !badge || !container || clientX === null) {
      if (line) line.style.opacity = '0'
      return
    }
    const rect = container.getBoundingClientRect()
    const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / Math.max(1, rect.width)) * 100))
    const { windowStartMs: ws, windowEndMs: we } = windowRef.current
    const tsMs = percentToMs(pct, ws, we)
    line.style.left = `${pct}%`
    line.style.opacity = '1'
    badge.textContent = formatTimestamp(new Date(tsMs).toISOString())
    // Keep tooltip inside right edge of viewport
    badge.style.left = pct > 84 ? '-72px' : '5px'
  }, [])

  const processDragFrame = useCallback(() => {
    dragRafRef.current = null
    if (!isDraggingRef.current) return
    const container = tracksContainerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const rawPct = ((lastDragClientXRef.current - rect.left) / Math.max(1, rect.width)) * 100
    const pct = Math.max(0, Math.min(100, rawPct))
    const {
      windowStartMs: ws,
      windowEndMs: we,
      dayStartMs: ds,
      dayEndMs: de,
      zoomHours: zh,
      viewportCenterMs: vc,
    } = windowRef.current

    // Gentle edge auto-pan when dragging against the left or right 3% margin while zoomed in
    if (zh < 24 && (rawPct < 3 || rawPct > 97)) {
      const spanMs = we - ws
      const dir = rawPct < 3 ? -1 : 1
      const nextCenter = panWindowCenter(ds, de, vc, zh, dir * spanMs * 0.015)
      if (nextCenter !== vc) {
        setViewportCenterMs(nextCenter)
        dragRafRef.current = requestAnimationFrame(processDragFrame)
      }
    }

    const tsMs = percentToMs(pct, ws, we)
    seekToTimestamp(tsMs, dragCameraIdRef.current, { isDrag: true })
  }, [seekToTimestamp])

  const handleTracksPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const targetEl = e.target as HTMLElement | null
    // Let event/package pins handle their own jump-with-preroll click
    if (targetEl?.closest('.timeline-pin')) return

    const laneEl = targetEl?.closest<HTMLElement>('[data-camera-id]')
    const laneCamId = laneEl?.dataset.cameraId || activeCameraIdRef.current
    dragCameraIdRef.current = laneCamId

    e.currentTarget.setPointerCapture(e.pointerId)
    isDraggingRef.current = true
    setDragging(true)

    const video = videoRef.current
    if (video && !video.paused) {
      wasPlayingBeforeDragRef.current = true
      video.pause()
      setIsPlaying(false)
    } else {
      wasPlayingBeforeDragRef.current = false
    }

    lastDragClientXRef.current = e.clientX
    updateHoverIndicator(e.clientX)

    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100))
    const { windowStartMs: ws, windowEndMs: we } = windowRef.current
    const tsMs = percentToMs(pct, ws, we)
    seekToTimestamp(tsMs, laneCamId, { isDrag: true })
  }

  const handleTracksPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    updateHoverIndicator(e.clientX)
    if (!isDraggingRef.current) return
    lastDragClientXRef.current = e.clientX
    if (dragRafRef.current === null) {
      dragRafRef.current = requestAnimationFrame(processDragFrame)
    }
  }

  const finishTracksDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    setDragging(false)
    if (dragRafRef.current !== null) {
      cancelAnimationFrame(dragRafRef.current)
      dragRafRef.current = null
    }
    if (clipSwitchTimerRef.current !== null) {
      clearTimeout(clipSwitchTimerRef.current)
      clipSwitchTimerRef.current = null
    }
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      // ignore release errors
    }

    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100))
    const { windowStartMs: ws, windowEndMs: we } = windowRef.current
    const finalTs = percentToMs(pct, ws, we)
    const shouldResume = wasPlayingBeforeDragRef.current
    wasPlayingBeforeDragRef.current = false

    seekToTimestamp(finalTs, dragCameraIdRef.current, {
      isDrag: false,
      autoPlay: shouldResume,
    })
  }

  // Non-passive mouse-wheel & macOS trackpad listener for cursor-anchored zoom & smooth horizontal pan
  useEffect(() => {
    const el = tracksContainerRef.current
    if (!el) return
    let zoomAccum = 0
    let lastZoomAt = 0

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100))
      const {
        windowStartMs: ws,
        windowEndMs: we,
        dayStartMs: ds,
        dayEndMs: de,
        zoomHours: zh,
        viewportCenterMs: vc,
      } = windowRef.current

      // Horizontal two-finger swipe (macOS trackpad) or Shift+Wheel (Windows) pans smoothly
      if (!e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        const deltaMs = (delta / Math.max(200, rect.width)) * (we - ws) * 1.15
        setViewportCenterMs(panWindowCenter(ds, de, vc, zh, deltaMs))
        return
      }

      // Vertical wheel or macOS trackpad pinch (ctrlKey) zooms anchored at cursor timestamp.
      // Accumulate small trackpad ticks so MacBook trackpads don't overshoot zoom levels.
      const now = performance.now()
      if (now - lastZoomAt > 180) {
        zoomAccum = 0
      }
      lastZoomAt = now
      zoomAccum += e.deltaY
      const threshold = e.ctrlKey ? 14 : 45
      if (Math.abs(zoomAccum) < threshold) return

      const direction = zoomAccum < 0 ? 1 : -1
      zoomAccum = 0

      const idx = ZOOM_LEVELS.indexOf(zh)
      const nextIdx =
        direction > 0
          ? Math.min(ZOOM_LEVELS.length - 1, idx + 1)
          : Math.max(0, idx - 1)
      if (nextIdx === idx) return

      const nextZoom = ZOOM_LEVELS[nextIdx]
      const anchorTs = percentToMs(pct, ws, we)
      setZoomHours(nextZoom)
      setViewportCenterMs(
        computeZoomedWindowCenter(ds, de, anchorTs, pct, nextZoom),
      )
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Direct in-player clip scrub bar handlers
  const scrubActiveClipAtClientX = (clientX: number, exact: boolean) => {
    const track = clipScrubTrackRef.current
    const clip = activeClipRef.current
    const video = videoRef.current
    if (!track || !clip) return

    const rect = track.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)))
    const dur =
      video && Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : Math.max(1, clip.durationSeconds)
    const offsetSec = ratio * dur
    const targetMs = new Date(clip.createdAt).getTime() + offsetSec * 1000

    syncPlayheadDom(targetMs)
    syncClipBarDom(offsetSec, dur)
    setClipCurrentSec(offsetSec)
    if (exact || performance.now() - lastReactSyncRef.current > 45) {
      lastReactSyncRef.current = performance.now()
      setPlayheadMs(targetMs)
    }
    applyVideoSeek(clip.id, offsetSec, { exact })
  }

  const handleClipBarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !activeClip?.playbackUrl) return
    e.currentTarget.setPointerCapture(e.pointerId)
    isClipBarDraggingRef.current = true
    const video = videoRef.current
    if (video && !video.paused) {
      wasPlayingBeforeDragRef.current = true
      video.pause()
      setIsPlaying(false)
    } else {
      wasPlayingBeforeDragRef.current = false
    }
    scrubActiveClipAtClientX(e.clientX, false)
  }

  const handleClipBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isClipBarDraggingRef.current) return
    scrubActiveClipAtClientX(e.clientX, false)
  }

  const handleClipBarPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isClipBarDraggingRef.current) return
    isClipBarDraggingRef.current = false
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      // ignore
    }
    scrubActiveClipAtClientX(e.clientX, true)
    if (wasPlayingBeforeDragRef.current && videoRef.current) {
      wasPlayingBeforeDragRef.current = false
      void videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {})
    }
  }

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
    const clip = activeClipRef.current
    if (!video || !clip) return
    const dur =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : clip.durationSeconds
    const nextSec = Math.max(0, Math.min(dur, video.currentTime + delta))
    applyVideoSeek(clip.id, nextSec, { exact: true })
    const nextMs = new Date(clip.createdAt).getTime() + nextSec * 1000
    setPlayheadMs(nextMs)
    setClipCurrentSec(nextSec)
    syncPlayheadDom(nextMs)
  }

  const handleZoomChange = (nextZoom: TimelineZoomHours) => {
    setZoomHours(nextZoom)
    // Keep playhead centered nicely when changing zoom via buttons
    setViewportCenterMs(
      computeZoomedWindowCenter(dayStartMs, dayEndMs, playheadMs, 50, nextZoom),
    )
  }

  const handlePanStep = (direction: -1 | 1) => {
    const spanMs = windowEndMs - windowStartMs
    setViewportCenterMs((prev) =>
      panWindowCenter(dayStartMs, dayEndMs, prev, zoomHours, direction * spanMs * 0.5),
    )
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
            <div className="player-video-box timeline-player-box">
              {activeClip?.playbackUrl ? (
                <video
                  ref={videoRef}
                  key={activeClip.id}
                  src={activeClip.playbackUrl}
                  poster={activeClip.thumbnailDataUrl}
                  preload="auto"
                  onLoadedMetadata={(e) => {
                    const video = e.currentTarget
                    video.playbackRate = playbackRate
                    const dur =
                      Number.isFinite(video.duration) && video.duration > 0
                        ? video.duration
                        : activeClip.durationSeconds
                    setClipDurationSec(dur)
                    const pending = pendingSeekRef.current
                    if (pending && pending.clipId === activeClip.id) {
                      const target = Math.max(
                        0,
                        Math.min(
                          pending.offsetSeconds,
                          Number.isFinite(video.duration) && video.duration > 0
                            ? Math.max(0, video.duration - 0.15)
                            : pending.offsetSeconds,
                        ),
                      )
                      try {
                        video.currentTime = target
                      } catch {
                        // ignore
                      }
                      setClipCurrentSec(target)
                      syncClipBarDom(target, dur)
                      if (pending.autoPlay) {
                        void video.play().then(() => setIsPlaying(true)).catch(() => {})
                      }
                      pendingSeekRef.current = null
                    }
                  }}
                  onSeeked={handleVideoSeeked}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={(e) => {
                    if (isDraggingRef.current || isClipBarDraggingRef.current) return
                    const current = e.currentTarget.currentTime
                    const dur =
                      Number.isFinite(e.currentTarget.duration) &&
                      e.currentTarget.duration > 0
                        ? e.currentTarget.duration
                        : activeClip.durationSeconds
                    const base = new Date(activeClip.createdAt).getTime()
                    const liveMs = base + current * 1000
                    syncPlayheadDom(liveMs)
                    syncClipBarDom(current, dur)
                    if (videoRef.current?.paused) {
                      setPlayheadMs(liveMs)
                      setClipCurrentSec(current)
                    }
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

            {/* Direct Smooth Clip Scrub Bar */}
            {activeClip?.playbackUrl && (
              <div className="clip-scrub-row" aria-label="Active clip scrubber">
                <span ref={clipCurrentTimeLabelRef} className="clip-scrub-time mono">
                  {formatClipClock(clipCurrentSec)}
                </span>
                <div
                  ref={clipScrubTrackRef}
                  className="clip-scrub-track"
                  onPointerDown={handleClipBarPointerDown}
                  onPointerMove={handleClipBarPointerMove}
                  onPointerUp={handleClipBarPointerUp}
                  onPointerCancel={handleClipBarPointerUp}
                >
                  <div className="clip-scrub-rail">
                    <div
                      ref={clipScrubFillRef}
                      className="clip-scrub-fill"
                      style={{
                        width: `${clipDurationSec > 0 ? Math.min(100, (clipCurrentSec / clipDurationSec) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <div
                    ref={clipScrubThumbRef}
                    className="clip-scrub-thumb"
                    style={{
                      left: `${clipDurationSec > 0 ? Math.min(100, (clipCurrentSec / clipDurationSec) * 100) : 0}%`,
                    }}
                  />
                </div>
                <span className="clip-scrub-time mono">
                  {formatClipClock(clipDurationSec)}
                </span>
              </div>
            )}

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
                    title={platformLabels.showInFileManager}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {dateKey}
              </span>
              <button
                type="button"
                className="btn btn-icon"
                title="Sync Ring cloud events"
                aria-label="Sync Ring cloud events"
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
              </button>
            </div>
          </div>
          <div className="panel-body form-stack">
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
                  {formatBytes(activeClip.sizeBytes)} · {activeClip.trigger}
                </div>
              </div>
            ) : null}

            <div className="field">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <label style={{ margin: 0 }}>Recordings</label>
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
                      ? `No clips for ${activeCameraTrack?.name ?? 'this camera'} on ${dateKey}.`
                      : `No local clips on ${dateKey}.`}
                  </div>
                ) : (
                  <>
                    {displayedClipList.slice(0, clipListLimit).map((clip) => (
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
                    ))}
                    {displayedClipList.length > clipListLimit && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}
                        onClick={() => setClipListLimit((n) => n + 100)}
                      >
                        Show More ({displayedClipList.length - clipListLimit} remaining)
                      </button>
                    )}
                  </>
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
                const midMs = getDayRangeMs(nextDate).startMs + 12 * 3600 * 1000
                setDateKey(nextDate)
                setPlayheadMs(midMs)
                setViewportCenterMs(midMs)
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
                  const midMs = getDayRangeMs(e.target.value).startMs + 12 * 3600 * 1000
                  setDateKey(e.target.value)
                  setPlayheadMs(midMs)
                  setViewportCenterMs(midMs)
                }}
              />
            </div>

            <button
              type="button"
              className="btn btn-icon"
              title="Next day"
              onClick={() => {
                const nextDate = shiftDateKey(dateKey, 1)
                const midMs = getDayRangeMs(nextDate).startMs + 12 * 3600 * 1000
                setDateKey(nextDate)
                setPlayheadMs(midMs)
                setViewportCenterMs(midMs)
              }}
            >
              <ChevronRight size={15} />
            </button>

            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const now = Date.now()
                const today = toLocalDateKey(new Date(now))
                setDateKey(today)
                setPlayheadMs(now)
                setViewportCenterMs(now)
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {zoomHours < 24 && (
              <>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Pan timeline earlier (or Shift+Scroll)"
                  onClick={() => handlePanStep(-1)}
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Center view on playhead"
                  onClick={() => setViewportCenterMs(playheadMs)}
                >
                  <Crosshair size={13} />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Pan timeline later (or Shift+Scroll)"
                  onClick={() => handlePanStep(1)}
                >
                  <ChevronRight size={14} />
                </button>
              </>
            )}
            <button
              type="button"
              className="btn btn-icon"
              title="Zoom out (or scroll down on timeline)"
              disabled={zoomIdx <= 0}
              onClick={() => handleZoomChange(ZOOM_LEVELS[Math.max(0, zoomIdx - 1)])}
            >
              <ZoomOut size={14} />
            </button>
            <div className="segmented" role="group" aria-label="Timeline zoom">
              {ZOOM_LEVELS.map((hrs) => (
                <button
                  key={hrs}
                  type="button"
                  className={zoomHours === hrs ? 'active' : ''}
                  onClick={() => handleZoomChange(hrs)}
                >
                  {formatZoomLabel(hrs)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-icon"
              title="Zoom in (or scroll up on timeline)"
              disabled={zoomIdx >= ZOOM_LEVELS.length - 1}
              onClick={() =>
                handleZoomChange(
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
            {platformLabels.timelineControlsHint}
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
              className={`timeline-lanes-col ${dragging ? 'dragging' : ''}`}
              onPointerDown={handleTracksPointerDown}
              onPointerMove={handleTracksPointerMove}
              onPointerUp={finishTracksDrag}
              onPointerCancel={finishTracksDrag}
              onPointerLeave={() => {
                if (!isDraggingRef.current) {
                  updateHoverIndicator(null)
                }
              }}
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
                    data-camera-id={cam.id}
                    className={`timeline-lane ${isSelected ? 'active-lane' : ''}`}
                  >
                    {camClips.map((clip) => {
                      const start = new Date(clip.createdAt).getTime()
                      const end = start + Math.max(1, clip.durationSeconds) * 1000
                      if (end < windowStartMs || start > windowEndMs) return null
                      const leftPct = Math.max(
                        0,
                        msToPercent(start, windowStartMs, windowEndMs),
                      )
                      const rightPct = Math.min(
                        100,
                        msToPercent(end, windowStartMs, windowEndMs),
                      )
                      const widthPct = Math.max(0.2, rightPct - leftPct)

                      return (
                        <div
                          key={clip.id}
                          className={`timeline-clip-bar trigger-${clip.trigger} ${
                            activeClip?.id === clip.id ? 'active' : ''
                          }`}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                          }}
                          title={`${clip.cameraName} · ${formatTimestamp(clip.createdAt)} (${formatDuration(clip.durationSeconds)}) [${clip.trigger}]`}
                        />
                      )
                    })}

                    {showLiveBar && liveStartMs !== null && (
                      <div
                        className="timeline-live-recording-bar"
                        style={{
                          left: `${Math.max(0, msToPercent(liveStartMs, windowStartMs, windowEndMs))}%`,
                          width: `${Math.max(
                            0.3,
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
                          onPointerDown={(e) => e.stopPropagation()}
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
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            seekToTimestamp(ts, cam.id, {
                              preRollSeconds: 3,
                              autoPlay: true,
                              centerIfOutOfView: true,
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
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectEventPin(ev)
                        }}
                      />
                    )
                  })}
                </div>
              )}

              {/* Zero-Rerender Hover Ghost Line + Tooltip */}
              <div ref={hoverLineRef} className="timeline-hover-line">
                <span ref={hoverBadgeRef} className="timeline-hover-badge mono" />
              </div>

              {/* 60fps Playhead Needle */}
              <div
                ref={playheadElRef}
                className="timeline-playhead"
                style={{
                  left: `${Math.max(0, Math.min(100, playheadPct))}%`,
                  opacity: playheadPct >= 0 && playheadPct <= 100 ? 1 : 0,
                }}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
