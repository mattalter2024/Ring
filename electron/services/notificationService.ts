import { Notification, type BrowserWindow, nativeImage } from 'electron'
import fs from 'node:fs'
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

export class NotificationService {
  private readonly iconPath: string
  private readonly getMainWindow: () => BrowserWindow | null

  constructor(iconPath: string, getMainWindow: () => BrowserWindow | null) {
    this.iconPath = iconPath
    this.getMainWindow = getMainWindow
  }

  notifyPackageAlert(options: NotifyPackageOptions): void {
    const win = this.getMainWindow()

    if (options.desktopEnabled && Notification.isSupported()) {
      const icon = fs.existsSync(this.iconPath)
        ? nativeImage.createFromPath(this.iconPath)
        : undefined
      const notification = new Notification({
        title: options.title,
        body: options.body,
        icon,
        silent: options.soundProfile !== 'none',
        urgency: 'normal',
      })
      notification.on('click', () => {
        const currentWin = this.getMainWindow()
        if (currentWin) {
          if (currentWin.isMinimized()) currentWin.restore()
          currentWin.show()
          currentWin.focus()
          if (options.cameraId) {
            currentWin.webContents.send('ringwatch:focus-camera', options.cameraId)
          }
        }
      })
      notification.show()
    }

    if (options.soundProfile !== 'none' && win && !win.isDestroyed()) {
      const payload: AlertSoundPayload = {
        profile: options.soundProfile,
        volume: options.volume,
        title: options.title,
        body: options.body,
      }
      win.webContents.send('ringwatch:play-alert-sound', payload)
    }
  }

  notifyNvrAlert(options: NotifyNvrAlertOptions): void {
    const win = this.getMainWindow()
    const soundProfile =
      options.soundProfile ??
      (options.severity === 'critical'
        ? 'urgent-radar'
        : options.severity === 'warning'
          ? 'soft-pulse'
          : 'none')

    if (options.desktopEnabled && Notification.isSupported()) {
      const icon = fs.existsSync(this.iconPath)
        ? nativeImage.createFromPath(this.iconPath)
        : undefined
      const notification = new Notification({
        title: options.title,
        body: options.body,
        icon,
        silent: soundProfile !== 'none',
        urgency: options.severity === 'critical' ? 'critical' : 'normal',
      })
      notification.on('click', () => {
        const currentWin = this.getMainWindow()
        if (currentWin) {
          if (currentWin.isMinimized()) currentWin.restore()
          currentWin.show()
          currentWin.focus()
        }
      })
      notification.show()
    }

    if (soundProfile !== 'none' && win && !win.isDestroyed()) {
      const payload: AlertSoundPayload = {
        profile: soundProfile,
        volume: options.volume ?? 0.75,
        title: options.title,
        body: options.body,
      }
      win.webContents.send('ringwatch:play-alert-sound', payload)
    }
  }
}
