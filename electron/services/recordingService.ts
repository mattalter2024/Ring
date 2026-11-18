import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LocalRecordingItem, StorageStats } from '../../shared/types'
import type { ConfigStore } from './configStore'
import type { StreamService } from './streamService'

const execFileAsync = promisify(execFile)

export interface RecordableRingCamera {
  recordToFile(outputPath: string, duration?: number): Promise<void>
  getSnapshot(): Promise<Buffer>
  getRecordingUrl(dingIdStr: string): Promise<string>
}

export class RecordingService {
  private readonly indexPath: string
  private readonly configStore: ConfigStore
  private readonly streamService: StreamService
  private recordings: LocalRecordingItem[] = []

  constructor(
    userDataDir: string,
    configStore: ConfigStore,
    streamService: StreamService,
  ) {
    this.indexPath = path.join(userDataDir, 'recordings-index.json')
    this.configStore = configStore
    this.streamService = streamService
    this.recordings = this.loadIndex()
  }

  private ensureRecordingsDir(): string {
    const dir = this.configStore.getPublicSettings().recordingsDir
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private loadIndex(): LocalRecordingItem[] {
    if (!fs.existsSync(this.indexPath)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item: LocalRecordingItem) =>
          Boolean(item?.filePath) && fs.existsSync(item.filePath),
      )
    } catch {
      return []
    }
  }

  private saveIndex(): void {
    try {
      fs.writeFileSync(
        this.indexPath,
        JSON.stringify(this.recordings, null, 2),
        'utf-8',
      )
    } catch {
      // Ignore write failures
    }
  }

  private withPlaybackUrls(items: LocalRecordingItem[]): LocalRecordingItem[] {
    return items.map((item) => ({
      ...item,
      playbackUrl: this.streamService.getRecordingPlaybackUrl(item.fileName),
    }))
  }

  listRecordings(): LocalRecordingItem[] {
    this.recordings = this.recordings
      .filter((r) => fs.existsSync(r.filePath))
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
    return this.withPlaybackUrls(this.recordings)
  }

  getRecordingById(id: string): LocalRecordingItem | undefined {
    return this.recordings.find((r) => r.id === id)
  }

  getStorageStats(): StorageStats {
    const settings = this.configStore.getPublicSettings()
    const dir = this.ensureRecordingsDir()
    const active = this.listRecordings()

    let totalBytes = 0
    let starredClips = 0
    for (const rec of active) {
      totalBytes += rec.sizeBytes
      if (rec.starred) starredClips++
    }

    let freeDiskBytes: number | null = null
    try {
      if (typeof fs.statfsSync === 'function') {
        const statfs = fs.statfsSync(dir)
        freeDiskBytes = Number(statfs.bavail) * Number(statfs.bsize)
      }
    } catch {
      freeDiskBytes = null
    }

    return {
      recordingsDir: dir,
      totalClips: active.length,
      starredClips,
      totalBytes,
      maxStorageGb: settings.maxStorageGb,
      retentionDays: settings.retentionDays,
      freeDiskBytes,
      oldestClipAt: active.length > 0 ? active[active.length - 1].createdAt : undefined,
      newestClipAt: active.length > 0 ? active[0].createdAt : undefined,
    }
  }

  toggleStar(id: string): LocalRecordingItem {
    let updated: LocalRecordingItem | undefined
    this.recordings = this.recordings.map((r) => {
      if (r.id !== id) return r
      updated = { ...r, starred: !r.starred }
      return updated
    })
    if (!updated) throw new Error(`Recording ${id} not found`)
    this.saveIndex()
    return {
      ...updated,
      playbackUrl: this.streamService.getRecordingPlaybackUrl(updated.fileName),
    }
  }

  deleteRecording(id: string): void {
    const target = this.recordings.find((r) => r.id === id)
    if (target && fs.existsSync(target.filePath)) {
      fs.unlinkSync(target.filePath)
    }
    this.recordings = this.recordings.filter((r) => r.id !== id)
    this.saveIndex()
  }

  exportRecording(id: string, destinationPath: string): string {
    const target = this.recordings.find((r) => r.id === id)
    if (!target || !fs.existsSync(target.filePath)) {
      throw new Error('Recording file no longer exists on disk')
    }
    fs.copyFileSync(target.filePath, destinationPath)
    return destinationPath
  }

  importVideoFiles(sourcePaths: string[]): LocalRecordingItem[] {
    const dir = this.ensureRecordingsDir()
    const imported: LocalRecordingItem[] = []

    for (const src of sourcePaths) {
      if (!fs.existsSync(src)) continue
      const base = path.basename(src)
      const safeName = base.replace(/[^a-zA-Z0-9._-]/g, '_')
      let fileName = safeName.toLowerCase().endsWith('.mp4')
        ? safeName
        : `${safeName}.mp4`
      let destPath = path.join(dir, fileName)
      if (fs.existsSync(destPath)) {
        const ext = path.extname(fileName)
        const stem = path.basename(fileName, ext)
        fileName = `${stem}_${Date.now()}${ext}`
        destPath = path.join(dir, fileName)
      }
      fs.copyFileSync(src, destPath)
      const stat = fs.statSync(destPath)
      const item: LocalRecordingItem = {
        id: crypto.randomUUID(),
        cameraId: 'imported-local',
        cameraName: 'Imported Video',
        filePath: destPath,
        fileName,
        createdAt: stat.mtime.toISOString(),
        durationSeconds: 30,
        sizeBytes: stat.size,
        trigger: 'imported',
        starred: false,
        playbackUrl: this.streamService.getRecordingPlaybackUrl(fileName),
      }
      this.recordings.unshift(item)
      imported.push(item)
    }

    if (imported.length > 0) {
      this.saveIndex()
    }
    return imported
  }

  rescanDirectory(): { recordings: LocalRecordingItem[]; stats: StorageStats } {
    const dir = this.ensureRecordingsDir()
    this.recordings = this.recordings.filter((r) => fs.existsSync(r.filePath))
    const indexedNames = new Set(this.recordings.map((r) => r.fileName.toLowerCase()))

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith('.mp4')) continue
      if (indexedNames.has(entry.name.toLowerCase())) continue

      const fullPath = path.join(dir, entry.name)
      const stat = fs.statSync(fullPath)
      const guessedCam = entry.name.split('_')[0]?.replace(/-/g, ' ') || 'Local Camera'
      const titleCam = guessedCam.replace(/\b\w/g, (m) => m.toUpperCase())

      this.recordings.push({
        id: crypto.randomUUID(),
        cameraId: 'local-disk',
        cameraName: titleCam,
        filePath: fullPath,
        fileName: entry.name,
        createdAt: stat.mtime.toISOString(),
        durationSeconds: 30,
        sizeBytes: stat.size,
        trigger: 'imported',
        starred: false,
      })
    }

    this.recordings.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    this.saveIndex()

    return {
      recordings: this.listRecordings(),
      stats: this.getStorageStats(),
    }
  }

  enforceRetentionAndQuota(overrideMaxBytes?: number): {
    prunedCount: number
    freedBytes: number
    stats: StorageStats
  } {
    const settings = this.configStore.getPublicSettings()
    let prunedCount = 0
    let freedBytes = 0

    // 1. Delete expired unstarred recordings older than retentionDays
    if (settings.retentionDays > 0) {
      const cutoffMs = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000
      const keep: LocalRecordingItem[] = []
      for (const rec of this.recordings) {
        const createdMs = new Date(rec.createdAt).getTime()
        if (!rec.starred && createdMs < cutoffMs) {
          if (fs.existsSync(rec.filePath)) {
            try {
              fs.unlinkSync(rec.filePath)
            } catch {
              // ignore unlink error
            }
          }
          prunedCount++
          freedBytes += rec.sizeBytes
        } else {
          keep.push(rec)
        }
      }
      this.recordings = keep
    }

    // 2. Enforce storage quota cap (delete oldest unstarred clips first)
    const maxBytes =
      overrideMaxBytes !== undefined
        ? overrideMaxBytes
        : settings.maxStorageGb > 0
          ? settings.maxStorageGb * 1024 * 1024 * 1024
          : 0

    if (maxBytes > 0) {
      let totalBytes = this.recordings.reduce((sum, r) => sum + r.sizeBytes, 0)
      if (totalBytes > maxBytes) {
        // Sort oldest first for pruning candidates
        const oldestUnstarred = [...this.recordings]
          .filter((r) => !r.starred)
          .sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )

        const toRemove = new Set<string>()
        for (const candidate of oldestUnstarred) {
          if (totalBytes <= maxBytes) break
          toRemove.add(candidate.id)
          if (fs.existsSync(candidate.filePath)) {
            try {
              fs.unlinkSync(candidate.filePath)
            } catch {
              // ignore unlink error
            }
          }
          totalBytes -= candidate.sizeBytes
          prunedCount++
          freedBytes += candidate.sizeBytes
        }

        if (toRemove.size > 0) {
          this.recordings = this.recordings.filter((r) => !toRemove.has(r.id))
        }
      }
    }

    if (prunedCount > 0) {
      this.saveIndex()
    }

    return {
      prunedCount,
      freedBytes,
      stats: this.getStorageStats(),
    }
  }

  private buildFileName(cameraName: string, trigger: string, date = new Date()): string {
    const slug = cameraName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `${slug || 'camera'}_${trigger}_${stamp}.mp4`
  }

  async captureFromRingCamera(params: {
    cameraId: string
    cameraName: string
    camera: RecordableRingCamera
    durationSeconds: number
    trigger: LocalRecordingItem['trigger']
  }): Promise<LocalRecordingItem> {
    const dir = this.ensureRecordingsDir()
    const fileName = this.buildFileName(params.cameraName, params.trigger)
    const filePath = path.join(dir, fileName)

    let thumbnailDataUrl: string | undefined
    try {
      const snap = await params.camera.getSnapshot()
      thumbnailDataUrl = `data:image/jpeg;base64,${snap.toString('base64')}`
    } catch {
      // Battery cameras may block snapshots while recording
    }

    await params.camera.recordToFile(filePath, params.durationSeconds)
    const stat = fs.statSync(filePath)

    const item: LocalRecordingItem = {
      id: crypto.randomUUID(),
      cameraId: params.cameraId,
      cameraName: params.cameraName,
      filePath,
      fileName,
      createdAt: new Date().toISOString(),
      durationSeconds: params.durationSeconds,
      sizeBytes: stat.size,
      trigger: params.trigger,
      starred: false,
      thumbnailDataUrl,
      playbackUrl: this.streamService.getRecordingPlaybackUrl(fileName),
    }

    this.recordings.unshift(item)
    this.saveIndex()
    this.enforceRetentionAndQuota()
    return item
  }

  async downloadCloudRecording(params: {
    cameraId: string
    cameraName: string
    camera: RecordableRingCamera
    dingId: string
    durationSeconds: number
    thumbnailDataUrl?: string
  }): Promise<LocalRecordingItem> {
    const dir = this.ensureRecordingsDir()
    const fileName = this.buildFileName(params.cameraName, 'cloud')
    const filePath = path.join(dir, fileName)

    const recordingUrl = await params.camera.getRecordingUrl(params.dingId)
    const response = await fetch(recordingUrl)
    if (!response.ok) {
      throw new Error(`Ring cloud download failed (HTTP ${response.status})`)
    }
    const arrayBuf = await response.arrayBuffer()
    fs.writeFileSync(filePath, Buffer.from(arrayBuf))

    const stat = fs.statSync(filePath)
    const item: LocalRecordingItem = {
      id: crypto.randomUUID(),
      cameraId: params.cameraId,
      cameraName: params.cameraName,
      filePath,
      fileName,
      createdAt: new Date().toISOString(),
      durationSeconds: params.durationSeconds,
      sizeBytes: stat.size,
      trigger: 'cloud-download',
      starred: false,
      thumbnailDataUrl: params.thumbnailDataUrl,
      playbackUrl: this.streamService.getRecordingPlaybackUrl(fileName),
    }

    this.recordings.unshift(item)
    this.saveIndex()
    this.enforceRetentionAndQuota()
    return item
  }

  async captureDemoRecording(params: {
    cameraId: string
    cameraName: string
    durationSeconds: number
    trigger: LocalRecordingItem['trigger']
    sourceImagePath: string
    thumbnailDataUrl: string
    createdAtOverride?: string
    starred?: boolean
  }): Promise<LocalRecordingItem> {
    const dir = this.ensureRecordingsDir()
    const createdDate = params.createdAtOverride
      ? new Date(params.createdAtOverride)
      : new Date()
    const fileName = this.buildFileName(params.cameraName, params.trigger, createdDate)
    const filePath = path.join(dir, fileName)

    const clipSeconds = Math.min(Math.max(4, params.durationSeconds), 10)
    const ffmpegBin = this.resolveFfmpegBinary()

    try {
      await execFileAsync(ffmpegBin, [
        '-y',
        '-loop',
        '1',
        '-i',
        params.sourceImagePath,
        '-t',
        String(clipSeconds),
        '-vf',
        'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-movflags',
        '+faststart',
        filePath,
      ])
    } catch (err) {
      throw new Error(
        `FFmpeg is required to encode demo MP4 clips (${err instanceof Error ? err.message : String(err)})`,
      )
    }

    const stat = fs.statSync(filePath)
    const item: LocalRecordingItem = {
      id: crypto.randomUUID(),
      cameraId: params.cameraId,
      cameraName: params.cameraName,
      filePath,
      fileName,
      createdAt: createdDate.toISOString(),
      durationSeconds: params.durationSeconds,
      sizeBytes: stat.size,
      trigger: params.trigger,
      starred: Boolean(params.starred),
      thumbnailDataUrl: params.thumbnailDataUrl,
      playbackUrl: this.streamService.getRecordingPlaybackUrl(fileName),
    }

    this.recordings.unshift(item)
    this.saveIndex()
    this.enforceRetentionAndQuota()
    return item
  }

  async seedDemoClipsIfEmpty(
    demoAssetsDir: string,
    seedSpecs: Array<{
      cameraId: string
      cameraName: string
      demoImage: string
      trigger: LocalRecordingItem['trigger']
      minutesAgo: number
      durationSeconds: number
      starred?: boolean
    }>,
  ): Promise<LocalRecordingItem[]> {
    if (this.listRecordings().length > 0) {
      return this.listRecordings()
    }
    for (const spec of seedSpecs) {
      const imgPath = path.join(demoAssetsDir, spec.demoImage)
      if (!fs.existsSync(imgPath)) continue
      const thumb = `data:image/jpeg;base64,${fs.readFileSync(imgPath).toString('base64')}`
      try {
        await this.captureDemoRecording({
          cameraId: spec.cameraId,
          cameraName: spec.cameraName,
          durationSeconds: spec.durationSeconds,
          trigger: spec.trigger,
          sourceImagePath: imgPath,
          thumbnailDataUrl: thumb,
          createdAtOverride: new Date(
            Date.now() - spec.minutesAgo * 60 * 1000,
          ).toISOString(),
          starred: spec.starred,
        })
      } catch {
        // If FFmpeg isn't installed on host PATH, skip seeding silently
        break
      }
    }
    return this.listRecordings()
  }

  resolveFfmpegBinary(): string {
    const custom = this.configStore.getPublicSettings().ffmpegPath
    if (custom) return custom
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bundled = require('ffmpeg-for-homebridge') as string | undefined
      if (bundled && typeof bundled === 'string') {
        const unpacked = bundled.includes('app.asar.unpacked')
          ? bundled
          : bundled.replace('app.asar', 'app.asar.unpacked')
        if (fs.existsSync(unpacked)) return unpacked
        if (fs.existsSync(bundled)) return bundled
      }
    } catch {
      // Fall back to PATH ffmpeg
    }
    return 'ffmpeg'
  }
}
