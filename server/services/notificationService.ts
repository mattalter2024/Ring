import type { AlertSoundPayload, AlertSoundProfile } from '../../shared/types'

export interface NotifyPackageOptions {
  title: string
  body: string
  cameraId?: string
  desktopEnabled: boolean
  soundProfile: AlertSoundProfile
  volume: number
}

export interface NotifyNvrAlertOptions {
  title: string
  body: string
  severity: 'info' | 'warning' | 'critical'
  desktopEnabled: boolean
  soundProfile?: AlertSoundProfile
  volume?: number
}

/**
 * Pure Node.js notification broadcaster.
 * Emits package & NVR alerts over SSE to all connected web browsers, which play the
 * configured Web Audio chime and trigger native Browser Desktop Notifications.
 */
export class NotificationService {
  private readonly broadcast: (channel: string, payload: unknown) => void

  constructor(broadcast: (channel: string, payload: unknown) => void) {
    this.broadcast = broadcast
  }

  notifyPackageAlert(options: NotifyPackageOptions): void {
    const payload: AlertSoundPayload = {
      profile: options.soundProfile,
      volume: options.volume,
      title: options.title,
      body: options.body,
      cameraId: options.cameraId,
      desktopEnabled: options.desktopEnabled,
    }
    this.broadcast('play-alert-sound', payload)
  }

  notifyNvrAlert(options: NotifyNvrAlertOptions): void {
    const soundProfile =
      options.soundProfile ??
      (options.severity === 'critical'
        ? 'urgent-radar'
        : options.severity === 'warning'
          ? 'soft-pulse'
          : 'none')

    const payload: AlertSoundPayload = {
      profile: soundProfile,
      volume: options.volume ?? 0.75,
      title: options.title,
      body: options.body,
      desktopEnabled: options.desktopEnabled,
    }
    this.broadcast('play-alert-sound', payload)
  }
}
