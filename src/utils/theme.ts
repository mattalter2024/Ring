import type { SystemThemeInfo } from '@shared/types'

const DEFAULT_ACCENT_DARK = '#1998d5'
const DEFAULT_ACCENT_LIGHT = '#0078d4'

interface Rgb {
  r: number
  g: number
  b: number
}

export function normalizeAccentHex(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const cleaned = raw.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6,8}$/.test(cleaned)) return null
  return `#${cleaned.slice(0, 6).toLowerCase()}`
}

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace(/^#/, '')
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  }
}

function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`
}

function mixRgb(a: Rgb, b: Rgb, ratio: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  }
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export interface ComputedThemeVars {
  mode: 'dark' | 'light'
  vars: Record<string, string>
}

export function computeThemeCssVars(theme: SystemThemeInfo): ComputedThemeVars {
  const isDark = theme.shouldUseDarkColors
  const accentHex =
    normalizeAccentHex(theme.accentColor) ??
    (isDark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT)

  const rgb = hexToRgb(accentHex)
  const white: Rgb = { r: 255, g: 255, b: 255 }
  const black: Rgb = { r: 10, g: 14, b: 20 }

  // Ensure hover state and text accents have strong legibility in both dark & light modes
  const accentHover = rgbToHex(
    isDark ? mixRgb(rgb, white, 0.16) : mixRgb(rgb, black, 0.14),
  )
  const accentText = rgbToHex(
    isDark
      ? relativeLuminance(rgb) < 0.25
        ? mixRgb(rgb, white, 0.42)
        : mixRgb(rgb, white, 0.2)
      : relativeLuminance(rgb) > 0.35
        ? mixRgb(rgb, black, 0.36)
        : mixRgb(rgb, black, 0.12),
  )
  const accentContrast = relativeLuminance(rgb) > 0.44 ? '#0b0e13' : '#ffffff'

  return {
    mode: isDark ? 'dark' : 'light',
    vars: {
      '--accent': accentHex,
      '--accent-hover': accentHover,
      '--accent-soft': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isDark ? 0.16 : 0.12})`,
      '--accent-border': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isDark ? 0.42 : 0.38})`,
      '--accent-text': accentText,
      '--accent-contrast': accentContrast,
    },
  }
}

export function applySystemTheme(theme: SystemThemeInfo): void {
  if (typeof document === 'undefined') return
  const { mode, vars } = computeThemeCssVars(theme)
  const root = document.documentElement
  root.dataset.theme = mode
  root.style.colorScheme = mode
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}
