export function formatRelativeTime(iso?: string): string {
  if (!iso) return '—'
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (diffSec < 10) return 'Just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return new Date(iso).toLocaleDateString()
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx++
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return m > 0 ? `${m}m ${String(rem).padStart(2, '0')}s` : `${rem}s`
}

export function formatSignalQuality(rssi: number | null): string {
  if (rssi === null) return 'Wired'
  if (rssi >= -55) return `${rssi} dBm · Strong`
  if (rssi >= -70) return `${rssi} dBm · Good`
  return `${rssi} dBm · Weak`
}
