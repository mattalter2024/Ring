export type ClientPlatform = 'mac' | 'windows' | 'other'

export function detectClientPlatform(
  nav?: {
    platform?: string
    userAgent?: string
    userAgentData?: { platform?: string }
  },
): ClientPlatform {
  const source =
    nav ??
    (typeof navigator !== 'undefined'
      ? (navigator as {
          platform?: string
          userAgent?: string
          userAgentData?: { platform?: string }
        })
      : undefined)

  const hint = [
    source?.userAgentData?.platform ?? '',
    source?.platform ?? '',
    source?.userAgent ?? '',
  ]
    .join(' ')
    .toLowerCase()

  if (hint.includes('mac') || hint.includes('darwin')) return 'mac'
  if (hint.includes('win')) return 'windows'
  return 'other'
}

export function applyClientPlatformAttribute(): ClientPlatform {
  const platform = detectClientPlatform()
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-platform', platform)
  }
  return platform
}

export interface PlatformLabels {
  platform: ClientPlatform
  isMac: boolean
  fileManagerName: string
  showInFileManager: string
  timelineControlsHint: string
  shortcutModifier: string
}

export function getPlatformLabels(platform = detectClientPlatform()): PlatformLabels {
  const isMac = platform === 'mac'
  return {
    platform,
    isMac,
    fileManagerName: isMac ? 'Finder' : 'Explorer',
    showInFileManager: isMac ? 'Show in Finder' : 'Show in Folder',
    timelineControlsHint: isMac
      ? 'Drag to scrub · Pinch or scroll to zoom · Two-finger swipe to pan'
      : 'Drag to scrub · Scroll wheel to zoom · Shift+Scroll to pan',
    shortcutModifier: isMac ? '⌘' : 'Ctrl',
  }
}
