import type { LocalRecordingItem, SecurityEvent } from '@shared/types'

export type TimelineZoomHours = 1 | 6 | 12 | 24

export interface TimelineWindow {
  windowStartMs: number
  windowEndMs: number
}

export interface TimelineTick {
  ms: number
  pct: number
  label: string
  major: boolean
}

export function toLocalDateKey(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  dt.setDate(dt.getDate() + deltaDays)
  return toLocalDateKey(dt)
}

export function getDayRangeMs(dateKey: string): { startMs: number; endMs: number } {
  const [y, m, d] = dateKey.split('-').map(Number)
  const start = new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0)
  const end = new Date(y, (m || 1) - 1, d || 1, 24, 0, 0, 0)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

export function computeVisibleWindow(
  dayStartMs: number,
  dayEndMs: number,
  centerMs: number,
  zoomHours: TimelineZoomHours,
): TimelineWindow {
  const spanMs = zoomHours * 60 * 60 * 1000
  const daySpan = dayEndMs - dayStartMs
  if (spanMs >= daySpan) {
    return { windowStartMs: dayStartMs, windowEndMs: dayEndMs }
  }
  let start = centerMs - spanMs / 2
  let end = centerMs + spanMs / 2
  if (start < dayStartMs) {
    start = dayStartMs
    end = dayStartMs + spanMs
  } else if (end > dayEndMs) {
    end = dayEndMs
    start = dayEndMs - spanMs
  }
  return { windowStartMs: start, windowEndMs: end }
}

export function msToPercent(
  tsMs: number,
  windowStartMs: number,
  windowEndMs: number,
): number {
  const span = Math.max(1, windowEndMs - windowStartMs)
  return ((tsMs - windowStartMs) / span) * 100
}

export function percentToMs(
  pct: number,
  windowStartMs: number,
  windowEndMs: number,
): number {
  const clamped = Math.max(0, Math.min(100, pct))
  return windowStartMs + (clamped / 100) * (windowEndMs - windowStartMs)
}

export function findClipAtTimestamp(
  recordings: LocalRecordingItem[],
  tsMs: number,
  cameraId?: string,
): { clip: LocalRecordingItem; offsetSeconds: number } | null {
  const candidates = cameraId
    ? recordings.filter((r) => r.cameraId === cameraId)
    : recordings

  for (const clip of candidates) {
    const startMs = new Date(clip.createdAt).getTime()
    const endMs = startMs + Math.max(1, clip.durationSeconds) * 1000
    if (tsMs >= startMs && tsMs <= endMs) {
      return {
        clip,
        offsetSeconds: Math.max(0, (tsMs - startMs) / 1000),
      }
    }
  }
  return null
}

export function findNearestTimelineStop(
  recordings: LocalRecordingItem[],
  events: SecurityEvent[],
  currentMs: number,
  direction: 'prev' | 'next',
): number | null {
  const points = new Set<number>()
  for (const r of recordings) points.add(new Date(r.createdAt).getTime())
  for (const e of events) points.add(new Date(e.timestamp).getTime())

  const sorted = Array.from(points).sort((a, b) => a - b)
  if (direction === 'next') {
    const found = sorted.find((ts) => ts > currentMs + 1500)
    return found ?? null
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] < currentMs - 1500) return sorted[i]
  }
  return null
}

export function buildRulerTicks(
  windowStartMs: number,
  windowEndMs: number,
  zoomHours: TimelineZoomHours,
): TimelineTick[] {
  const stepMinutes =
    zoomHours === 1 ? 10 : zoomHours === 6 ? 30 : zoomHours === 12 ? 60 : 120
  const stepMs = stepMinutes * 60 * 1000
  const firstTick = Math.ceil(windowStartMs / stepMs) * stepMs

  const ticks: TimelineTick[] = []
  for (let ms = firstTick; ms <= windowEndMs; ms += stepMs) {
    const dt = new Date(ms)
    const hours = String(dt.getHours()).padStart(2, '0')
    const mins = String(dt.getMinutes()).padStart(2, '0')
    const major = dt.getMinutes() === 0
    ticks.push({
      ms,
      pct: msToPercent(ms, windowStartMs, windowEndMs),
      label: `${hours}:${mins}`,
      major,
    })
  }
  return ticks
}
