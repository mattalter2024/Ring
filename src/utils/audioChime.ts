import type { AlertSoundProfile } from '@shared/types'

let sharedAudioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!Ctor) return null
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctor()
  }
  if (sharedAudioCtx.state === 'suspended') {
    void sharedAudioCtx.resume()
  }
  return sharedAudioCtx
}

function scheduleTone(
  ctx: AudioContext,
  freq: number,
  startOffset: number,
  duration: number,
  volume: number,
  type: OscillatorType = 'sine',
): void {
  const now = ctx.currentTime + startOffset
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = type
  osc.frequency.setValueAtTime(freq, now)

  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(Math.max(0.01, volume * 0.32), now + 0.018)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.start(now)
  osc.stop(now + duration + 0.02)
}

export function playAlertChime(
  profile: AlertSoundProfile,
  volume = 0.85,
): void {
  if (profile === 'none' || volume <= 0) return
  const ctx = getAudioContext()
  if (!ctx) return

  const clamped = Math.max(0.05, Math.min(1, volume))

  switch (profile) {
    case 'crisp-chime':
      scheduleTone(ctx, 784, 0.0, 0.22, clamped, 'triangle') // G5
      scheduleTone(ctx, 1046.5, 0.14, 0.34, clamped, 'sine') // C6
      scheduleTone(ctx, 1318.5, 0.28, 0.45, clamped * 0.9, 'sine') // E6
      break
    case 'doorbell-double':
      scheduleTone(ctx, 659.25, 0.0, 0.38, clamped, 'sine') // E5
      scheduleTone(ctx, 523.25, 0.32, 0.55, clamped, 'sine') // C5
      break
    case 'soft-pulse':
      scheduleTone(ctx, 587.33, 0.0, 0.28, clamped * 0.75, 'sine')
      scheduleTone(ctx, 880, 0.22, 0.35, clamped * 0.75, 'sine')
      break
    case 'urgent-radar':
      scheduleTone(ctx, 987.77, 0.0, 0.15, clamped, 'square')
      scheduleTone(ctx, 987.77, 0.2, 0.15, clamped, 'square')
      scheduleTone(ctx, 1174.66, 0.4, 0.28, clamped, 'triangle')
      break
  }
}
