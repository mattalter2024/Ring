import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  CameraStorageUsage,
  DiskHealthStatus,
  LocalRecordingItem,
  StorageDriveInfo,
  StorageStats,
} from '../../shared/types'
import type { ConfigStore } from './configStore'
import type { StreamService, StreamableRingCamera } from './streamService'

const execFileAsync = promisify(execFile)
const BYTES_PER_GB = 1024 * 1024 * 1024

export const MOTION_GRID_WIDTH = 64
export const MOTION_GRID_HEIGHT = 36
export const MOTION_GRID_PIXELS = MOTION_GRID_WIDTH * MOTION_GRID_HEIGHT

export interface LumaSceneChangeResult {
  significant: boolean
  changedRatio: number
  lowerChangedRatio: number
  meanAbsDiff: number
  prevMean: number
  currMean: number
}

/**
 * Illumination-normalized scene-change detector comparing two 64x36 grayscale luma grids.
 * Subtracts global brightness drift (passing clouds, sun angle, IR exposure) while catching
 * localized object/person/box changes—especially in the lower 75% porch/walkway delivery zone.
 */
export function computeLumaSceneChange(
  prev: Buffer,
  curr: Buffer,
): LumaSceneChangeResult {
  const len = Math.min(prev.length, curr.length, MOTION_GRID_PIXELS)
  if (len < 64) {
    return {
      significant: false,
      changedRatio: 0,
      lowerChangedRatio: 0,
      meanAbsDiff: 0,
      prevMean: 0,
      currMean: 0,
    }
  }

  let prevSum = 0
  let currSum = 0
  for (let i = 0; i < len; i++) {
    prevSum += prev[i]
    currSum += curr[i]
  }
  const prevMean = prevSum / len
  const currMean = currSum / len

  // Ignore nearly black / blank frames during camera reconnects
  if (prevMean < 4 || currMean < 4) {
    return {
      significant: false,
      changedRatio: 0,
      lowerChangedRatio: 0,
      meanAbsDiff: 0,
      prevMean,
      currMean,
    }
  }

  const deltaMean = currMean - prevMean
  const lowerStart = Math.floor(len * 0.25)
  const lowerLen = Math.max(1, len - lowerStart)

  let changedCount = 0
  let lowerChangedCount = 0
  let absDiffSum = 0

  for (let i = 0; i < len; i++) {
    const diff = Math.abs(curr[i] - deltaMean - prev[i])
    absDiffSum += diff
    if (diff >= 22) {
      changedCount++
      if (i >= lowerStart) {
        lowerChangedCount++
      }
    }
  }

  const changedRatio = changedCount / len
  const lowerChangedRatio = lowerChangedCount / lowerLen
  const meanAbsDiff = absDiffSum / len
  const significant =
    (changedRatio >= 0.032 || lowerChangedRatio >= 0.03) && meanAbsDiff >= 1.2

  return {
    significant,
    changedRatio,
    lowerChangedRatio,
    meanAbsDiff,
    prevMean,
    currMean,
  }
}

export interface RecordableRingCamera {
  recordToFile(outputPath: string, duration?: number): Promise<void>
  streamVideo?: StreamableRingCamera['streamVideo']
  getSnapshot(): Promise<Buffer>
  getRecordingUrl(dingIdStr: string): Promise<string>
}

export interface NvrSegmentTarget {
  dir: string
  prefix: string
  segmentPattern: string
  ffmpegSegmentPattern: string
  segmentListPath: string
  ffmpegSegmentListPath: string
}

export interface ResolvedStorageLocation {
  activeDir: string
  primaryOnline: boolean
  usingFailover: boolean
}

export class RecordingService {
  private readonly indexPath: string
  private readonly configStore: ConfigStore
  private readonly streamService: StreamService
  private recordings: LocalRecordingItem[] = []
  private recordingsById = new Map<string, LocalRecordingItem>()
  private recordingsByPath = new Map<string, LocalRecordingItem>()
  private statsCache: { stats: StorageStats; computedAtMs: number; settingsKey: string } | null =
    null
  private saveIndexTimer: NodeJS.Timeout | null = null
  private saveIndexDirty = false

  constructor(
    userDataDir: string,
    configStore: ConfigStore,
    streamService: StreamService,
  ) {
    this.indexPath = path.join(userDataDir, 'recordings-index.json')
    this.configStore = configStore
    this.streamService = streamService
    this.recordings = this.loadIndex()
    this.rebuildLookupMaps()
    this.streamService.setRecordingPathResolver((id) => this.getRecordingById(id)?.filePath)
  }

  private isMountRootAvailable(dirPath: string): boolean {
    const trimmed = dirPath.trim()
    if (!trimmed) return false

    if (process.platform === 'win32') {
      const parsed = path.parse(trimmed)
      if (parsed.root && !fs.existsSync(parsed.root)) {
        return false
      }
      return true
    }

    // On POSIX, prevent creating fake folders inside unmounted external drive roots
    const normalized = path.resolve(trimmed)
    const parts = normalized.split(path.sep).filter(Boolean)
    if (parts.length >= 2 && (parts[0] === 'mnt' || parts[0] === 'Volumes')) {
      const mountRoot = path.sep + path.join(parts[0], parts[1])
      if (!fs.existsSync(mountRoot)) return false
    } else if (parts.length >= 3 && parts[0] === 'media') {
      const mountRoot = path.sep + path.join(parts[0], parts[1], parts[2])
      if (!fs.existsSync(mountRoot)) return false
    }
    return true
  }

  isDirectoryWritable(dirPath: string): boolean {
    const trimmed = dirPath.trim()
    if (!trimmed) return false
    if (!this.isMountRootAvailable(trimmed)) return false

    try {
      if (!fs.existsSync(trimmed)) {
        fs.mkdirSync(trimmed, { recursive: true })
      }
      const stat = fs.statSync(trimmed)
      if (!stat.isDirectory()) return false
      fs.accessSync(trimmed, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  resolveActiveStorageDir(): ResolvedStorageLocation {
    const settings = this.configStore.getPublicSettings()
    if (this.isDirectoryWritable(settings.recordingsDir)) {
      return {
        activeDir: settings.recordingsDir,
        primaryOnline: true,
        usingFailover: false,
      }
    }

    if (
      settings.failoverRecordingsDir &&
      this.isDirectoryWritable(settings.failoverRecordingsDir)
    ) {
      return {
        activeDir: settings.failoverRecordingsDir,
        primaryOnline: false,
        usingFailover: true,
      }
    }

    const fallback = this.configStore.getDefaultRecordingsDir()
    try {
      fs.mkdirSync(fallback, { recursive: true })
    } catch {
      // ignore fallback mkdir error
    }
    return {
      activeDir: fallback,
      primaryOnline: false,
      usingFailover: path.resolve(fallback) !== path.resolve(settings.recordingsDir),
    }
  }

  getAllStorageRoots(): string[] {
    const settings = this.configStore.getPublicSettings()
    const candidates = [
      settings.recordingsDir,
      settings.failoverRecordingsDir,
      this.configStore.getDefaultRecordingsDir(),
    ]
    const unique = new Set<string>()
    for (const candidate of candidates) {
      if (!candidate?.trim()) continue
      if (this.isMountRootAvailable(candidate) && fs.existsSync(candidate)) {
        unique.add(path.resolve(candidate))
      }
    }
    return Array.from(unique)
  }

  private ensureRecordingsDir(): string {
    return this.resolveActiveStorageDir().activeDir
  }

  private formatLocalDateFolder(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  private resolveClipDirectory(cameraName: string, date = new Date()): string {
    const activeDir = this.ensureRecordingsDir()
    const settings = this.configStore.getPublicSettings()
    if (!settings.organizeByDateFolder) {
      return activeDir
    }
    const dayFolder = this.formatLocalDateFolder(date)
    const camSlug = this.buildSlug(cameraName)
    const targetDir = path.join(activeDir, dayFolder, camSlug)
    fs.mkdirSync(targetDir, { recursive: true })
    return targetDir
  }

  private getDiskSpace(dirPath: string): {
    totalBytes: number | null
    freeBytes: number | null
  } {
    try {
      if (typeof fs.statfsSync === 'function' && fs.existsSync(dirPath)) {
        const statfs = fs.statfsSync(dirPath)
        const totalBytes = Number(statfs.blocks) * Number(statfs.bsize)
        const freeBytes = Number(statfs.bavail) * Number(statfs.bsize)
        return {
          totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
          freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
        }
      }
    } catch {
      // ignore statfs errors
    }
    return { totalBytes: null, freeBytes: null }
  }

  async listStorageDrives(): Promise<StorageDriveInfo[]> {
    const settings = this.configStore.getPublicSettings()
    const primaryNorm = path.resolve(settings.recordingsDir).toLowerCase()
    const failoverNorm = settings.failoverRecordingsDir
      ? path.resolve(settings.failoverRecordingsDir).toLowerCase()
      : ''

    const matchesTarget = (driveRoot: string, targetNorm: string): boolean => {
      if (!targetNorm) return false
      const normRoot = path.resolve(driveRoot).toLowerCase()
      if (process.platform === 'win32') {
        return targetNorm.slice(0, 2) === normRoot.slice(0, 2)
      }
      return targetNorm === normRoot || targetNorm.startsWith(`${normRoot}${path.sep}`)
    }

    if (process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ConvertTo-Json -Compress',
          ],
          { timeout: 6000 },
        )
        const trimmed = stdout.trim()
        if (trimmed) {
          const parsed = JSON.parse(trimmed) as
            | Array<Record<string, unknown>>
            | Record<string, unknown>
          const rows = Array.isArray(parsed) ? parsed : [parsed]
          const drives: StorageDriveInfo[] = []
          for (const row of rows) {
            const deviceId = String(row.DeviceID ?? '').trim()
            if (!deviceId) continue
            const drivePath = deviceId.endsWith('\\') ? deviceId : `${deviceId}\\`
            const rawType = Number(row.DriveType ?? 0)
            const driveType: StorageDriveInfo['driveType'] =
              rawType === 2
                ? 'removable'
                : rawType === 3
                  ? 'fixed'
                  : rawType === 4
                    ? 'network'
                    : 'unknown'
            // Skip optical CD/DVD drives (5) and RAM disks (6)
            if (rawType === 5 || rawType === 6) continue
            const totalBytes =
              typeof row.Size === 'number' && Number.isFinite(row.Size) ? row.Size : null
            const freeBytes =
              typeof row.FreeSpace === 'number' && Number.isFinite(row.FreeSpace)
                ? row.FreeSpace
                : null
            const usedBytes =
              totalBytes !== null && freeBytes !== null
                ? Math.max(0, totalBytes - freeBytes)
                : null
            const volName = String(row.VolumeName ?? '').trim()
            const typeTag =
              driveType === 'removable'
                ? 'External USB'
                : driveType === 'network'
                  ? 'Network / NAS'
                  : 'Local Disk'
            const label = volName ? `${volName} (${deviceId})` : `${typeTag} (${deviceId})`
            let writable = false
            try {
              fs.accessSync(drivePath, fs.constants.W_OK)
              writable = true
            } catch {
              writable = freeBytes !== null && freeBytes > 0
            }

            drives.push({
              id: deviceId.toLowerCase(),
              path: drivePath,
              label,
              driveType,
              totalBytes,
              freeBytes,
              usedBytes,
              writable,
              isPrimary: matchesTarget(drivePath, primaryNorm),
              isFailover: matchesTarget(drivePath, failoverNorm),
            })
          }
          if (drives.length > 0) {
            return drives
          }
        }
      } catch {
        // Fall through to generic filesystem listing
      }
    }

    // Fallback for Linux / macOS / restricted Windows environments
    const candidates: Array<{
      path: string
      label: string
      driveType: StorageDriveInfo['driveType']
    }> = [
      {
        path: settings.recordingsDir,
        label: 'Primary Recordings Vault',
        driveType: 'fixed',
      },
    ]

    if (settings.failoverRecordingsDir) {
      candidates.push({
        path: settings.failoverRecordingsDir,
        label: 'Failover Vault',
        driveType: 'fixed',
      })
    }

    const defaultDir = this.configStore.getDefaultRecordingsDir()
    if (path.resolve(defaultDir) !== path.resolve(settings.recordingsDir)) {
      candidates.push({
        path: defaultDir,
        label: 'Internal Local Vault',
        driveType: 'fixed',
      })
    }

    for (const mountParent of ['/Volumes', '/mnt', '/media']) {
      if (!fs.existsSync(mountParent)) continue
      try {
        for (const entry of fs.readdirSync(mountParent, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const mountPath = path.join(mountParent, entry.name)
          candidates.push({
            path: mountPath,
            label: `${entry.name} (Mounted Drive)`,
            driveType: 'removable',
          })
        }
      } catch {
        // ignore unreadable mount directory
      }
    }

    const seen = new Set<string>()
    const drives: StorageDriveInfo[] = []
    for (const cand of candidates) {
      const resolved = path.resolve(cand.path)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      const writable = this.isDirectoryWritable(resolved)
      const { totalBytes, freeBytes } = this.getDiskSpace(resolved)
      const usedBytes =
        totalBytes !== null && freeBytes !== null
          ? Math.max(0, totalBytes - freeBytes)
          : null
      drives.push({
        id: resolved,
        path: resolved,
        label: cand.label,
        driveType: cand.driveType,
        totalBytes,
        freeBytes,
        usedBytes,
        writable,
        isPrimary: matchesTarget(resolved, primaryNorm),
        isFailover: matchesTarget(resolved, failoverNorm),
      })
    }

    return drives
  }

  private rebuildLookupMaps(): void {
    this.recordingsById.clear()
    this.recordingsByPath.clear()
    for (const r of this.recordings) {
      this.recordingsById.set(r.id, r)
      this.recordingsByPath.set(path.resolve(r.filePath).toLowerCase(), r)
    }
    this.statsCache = null
  }

  private sortRecordingsDesc(): void {
    this.recordings.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }

  private stripExcessThumbnails(items: LocalRecordingItem[]): {
    cleaned: LocalRecordingItem[]
    strippedAny: boolean
  } {
    let strippedAny = false
    let keptEventThumbs = 0
    const cleaned = items.map((item) => {
      if (!item.thumbnailDataUrl) return item
      // Continuous 24/7 NVR clips reuse the camera's live snapshot in the UI;
      // storing a 200KB base64 JPEG on every 2-minute segment bloats RAM/IPC/JSON to 100s of MB.
      if (item.trigger === 'continuous') {
        strippedAny = true
        const { thumbnailDataUrl: _drop, ...rest } = item
        return rest
      }
      if (keptEventThumbs >= 60) {
        strippedAny = true
        const { thumbnailDataUrl: _drop, ...rest } = item
        return rest
      }
      keptEventThumbs++
      return item
    })
    return { cleaned, strippedAny }
  }

  private loadIndex(): LocalRecordingItem[] {
    if (!fs.existsSync(this.indexPath)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
      if (!Array.isArray(parsed)) return []
      const existing = parsed.filter(
        (item: LocalRecordingItem) =>
          Boolean(item?.filePath) && fs.existsSync(item.filePath),
      )
      existing.sort(
        (a: LocalRecordingItem, b: LocalRecordingItem) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      const { cleaned, strippedAny } = this.stripExcessThumbnails(existing)
      if (strippedAny) {
        // Immediately shrink bloated legacy recordings-index.json in background
        this.saveIndexDirty = true
        this.scheduleAsyncIndexSave(100)
      }
      return cleaned
    } catch {
      return []
    }
  }

  private scheduleAsyncIndexSave(delayMs = 600): void {
    if (this.saveIndexTimer) return
    this.saveIndexTimer = setTimeout(() => {
      this.saveIndexTimer = null
      if (!this.saveIndexDirty) return
      this.saveIndexDirty = false
      const serialized = JSON.stringify(this.recordings)
      void fs.promises.writeFile(this.indexPath, serialized, 'utf-8').catch(() => {
        // Ignore transient write failures
      })
    }, delayMs)
    if (typeof this.saveIndexTimer.unref === 'function') {
      this.saveIndexTimer.unref()
    }
  }

  private saveIndex(): void {
    this.rebuildLookupMaps()
    this.saveIndexDirty = true
    this.scheduleAsyncIndexSave(500)
  }

  flushIndexSync(): void {
    if (this.saveIndexTimer) {
      clearTimeout(this.saveIndexTimer)
      this.saveIndexTimer = null
    }
    if (!this.saveIndexDirty) return
    this.saveIndexDirty = false
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.recordings), 'utf-8')
    } catch {
      // Ignore write failures during shutdown
    }
  }

  private buildPlaybackUrl(item: Pick<LocalRecordingItem, 'id' | 'fileName'>): string {
    return this.streamService.getRecordingPlaybackUrlById(item.id, item.fileName)
  }

  private withPlaybackUrls(items: LocalRecordingItem[]): LocalRecordingItem[] {
    return items.map((item) => ({
      ...item,
      playbackUrl: this.buildPlaybackUrl(item),
    }))
  }

  isDemoFilename(fileName: string): boolean {
    const lower = path.basename(fileName).toLowerCase()
    return (
      lower.startsWith('front-porch-doorbell-pro_') ||
      lower.startsWith('driveway-floodlight-cam_') ||
      lower.startsWith('back-patio-stick-up-cam_') ||
      lower.includes('_demo_')
    )
  }

  isDemoRecording(rec: Pick<LocalRecordingItem, 'cameraId' | 'fileName' | 'notes'>): boolean {
    if (rec.cameraId.startsWith('demo-')) return true
    if (rec.notes && rec.notes.toLowerCase().includes('demo sample')) return true
    return this.isDemoFilename(rec.fileName)
  }

  private getActiveRecordingsForMode(): LocalRecordingItem[] {
    const mode = this.configStore.getPublicSettings().mode
    if (mode === 'live') {
      return this.recordings.filter((r) => !this.isDemoRecording(r))
    }
    return this.recordings
  }

  listRecordings(): LocalRecordingItem[] {
    return this.withPlaybackUrls(this.getActiveRecordingsForMode())
  }

  getRecordingById(id: string): LocalRecordingItem | undefined {
    return this.recordingsById.get(id)
  }

  getStorageStats(overrideFreeDiskBytes?: number): StorageStats {
    const settings = this.configStore.getPublicSettings()
    const settingsKey = `${settings.mode}|${settings.recordingsDir}|${settings.failoverRecordingsDir}|${settings.maxStorageGb}|${settings.retentionDays}|${settings.lowDiskWarningGb}|${settings.minFreeDiskGb}`
    const nowMs = Date.now()
    if (
      overrideFreeDiskBytes === undefined &&
      this.statsCache &&
      this.statsCache.settingsKey === settingsKey &&
      nowMs - this.statsCache.computedAtMs < 2000
    ) {
      return this.statsCache.stats
    }

    const resolved = this.resolveActiveStorageDir()
    const active = this.getActiveRecordingsForMode()

    let totalBytes = 0
    let protectedBytes = 0
    let starredClips = 0
    const cameraMap = new Map<string, CameraStorageUsage>()

    const recentCutoffMs = nowMs - 24 * 60 * 60 * 1000
    let recentBytes = 0
    let oldestRecentMs = nowMs

    for (const rec of active) {
      totalBytes += rec.sizeBytes
      if (rec.starred) {
        starredClips++
        protectedBytes += rec.sizeBytes
      }

      const createdMs = new Date(rec.createdAt).getTime()
      if (Number.isFinite(createdMs) && createdMs >= recentCutoffMs) {
        recentBytes += rec.sizeBytes
        if (createdMs < oldestRecentMs) oldestRecentMs = createdMs
      }

      const existing = cameraMap.get(rec.cameraId)
      if (!existing) {
        cameraMap.set(rec.cameraId, {
          cameraId: rec.cameraId,
          cameraName: rec.cameraName,
          clipCount: 1,
          totalBytes: rec.sizeBytes,
          protectedBytes: rec.starred ? rec.sizeBytes : 0,
          oldestClipAt: rec.createdAt,
          newestClipAt: rec.createdAt,
        })
      } else {
        existing.clipCount++
        existing.totalBytes += rec.sizeBytes
        if (rec.starred) existing.protectedBytes += rec.sizeBytes
        if (!existing.oldestClipAt || rec.createdAt < existing.oldestClipAt) {
          existing.oldestClipAt = rec.createdAt
        }
        if (!existing.newestClipAt || rec.createdAt > existing.newestClipAt) {
          existing.newestClipAt = rec.createdAt
        }
      }
    }

    const disk = this.getDiskSpace(resolved.activeDir)
    const totalDiskBytes = disk.totalBytes
    const freeDiskBytes =
      overrideFreeDiskBytes !== undefined ? overrideFreeDiskBytes : disk.freeBytes

    const { minFreeBytes, lowWarnBytes } = this.resolveEffectiveDiskThresholds(
      totalDiskBytes,
      overrideFreeDiskBytes !== undefined,
    )

    let diskHealth: DiskHealthStatus = 'healthy'
    if (!this.isDirectoryWritable(resolved.activeDir)) {
      diskHealth = 'offline'
    } else if (freeDiskBytes !== null && freeDiskBytes < minFreeBytes) {
      diskHealth = 'critical'
    } else if (
      !resolved.primaryOnline ||
      (freeDiskBytes !== null && freeDiskBytes < lowWarnBytes)
    ) {
      diskHealth = 'warning'
    }

    const spanHours =
      recentBytes > 0
        ? Math.min(24, Math.max(1, (nowMs - oldestRecentMs) / (60 * 60 * 1000)))
        : 0
    const writeRateBytesPerHour =
      recentBytes > 0 && spanHours > 0 ? Math.round(recentBytes / spanHours) : 0

    let estimatedDaysRemaining: number | null = null
    if (writeRateBytesPerHour > 0) {
      const diskVaultCeiling =
        freeDiskBytes !== null
          ? Math.max(0, freeDiskBytes + totalBytes - minFreeBytes)
          : Infinity
      const quotaCeiling =
        settings.maxStorageGb > 0 ? settings.maxStorageGb * BYTES_PER_GB : Infinity
      const effectiveCeiling = Math.min(diskVaultCeiling, quotaCeiling)
      if (Number.isFinite(effectiveCeiling)) {
        const ringBudget = Math.max(0, effectiveCeiling - protectedBytes)
        const days = ringBudget / (writeRateBytesPerHour * 24)
        estimatedDaysRemaining = Number(days.toFixed(1))
      }
    }

    const perCameraUsage = Array.from(cameraMap.values()).sort(
      (a, b) => b.totalBytes - a.totalBytes,
    )

    const result: StorageStats = {
      recordingsDir: settings.recordingsDir,
      activeRecordingsDir: resolved.activeDir,
      failoverRecordingsDir: settings.failoverRecordingsDir,
      usingFailover: resolved.usingFailover,
      primaryOnline: resolved.primaryOnline,
      totalClips: active.length,
      starredClips,
      totalBytes,
      protectedBytes,
      maxStorageGb: settings.maxStorageGb,
      retentionDays: settings.retentionDays,
      lowDiskWarningGb: settings.lowDiskWarningGb,
      minFreeDiskGb: settings.minFreeDiskGb,
      diskHealth,
      totalDiskBytes,
      freeDiskBytes,
      writeRateBytesPerHour,
      estimatedDaysRemaining,
      oldestClipAt: active.length > 0 ? active[active.length - 1].createdAt : undefined,
      newestClipAt: active.length > 0 ? active[0].createdAt : undefined,
      perCameraUsage,
    }

    if (overrideFreeDiskBytes === undefined) {
      this.statsCache = { stats: result, computedAtMs: nowMs, settingsKey }
    }
    return result
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
      playbackUrl: this.buildPlaybackUrl(updated),
    }
  }

  deleteRecording(id: string): void {
    const target = this.recordings.find((r) => r.id === id)
    if (target && fs.existsSync(target.filePath)) {
      try {
        fs.rmSync(target.filePath, {
          force: true,
          maxRetries: 4,
          retryDelay: 150,
        })
      } catch {
        // Ignore transient Windows EBUSY/EPERM lock if video element just closed
      }
    }
    this.recordings = this.recordings.filter((r) => r.id !== id)
    this.saveIndex()
    this.cleanupEmptySubdirs()
  }

  clearAllRecordings(includeStarred = true): {
    deletedCount: number
    freedBytes: number
    remainingCount: number
    stats: StorageStats
  } {
    let deletedCount = 0
    let freedBytes = 0
    const keep: LocalRecordingItem[] = []

    for (const rec of this.recordings) {
      if (!includeStarred && rec.starred) {
        keep.push(rec)
        continue
      }
      if (rec.filePath && fs.existsSync(rec.filePath)) {
        try {
          fs.rmSync(rec.filePath, {
            force: true,
            maxRetries: 4,
            retryDelay: 150,
          })
        } catch {
          // Ignore transient lock
        }
      }
      deletedCount++
      freedBytes += rec.sizeBytes
    }

    // Also clear any unindexed leftover demo MP4 files if clearing everything
    if (includeStarred) {
      for (const root of this.getAllStorageRoots()) {
        for (const fullPath of this.collectMp4FilesRecursive(root, 3)) {
          if (this.isDemoFilename(fullPath)) {
            try {
              const stat = fs.statSync(fullPath)
              fs.rmSync(fullPath, { force: true, maxRetries: 4, retryDelay: 150 })
              freedBytes += stat.size
            } catch {
              // ignore
            }
          }
        }
      }
    }

    this.recordings = keep
    this.rebuildLookupMaps()
    this.saveIndexDirty = true
    this.flushIndexSync()
    this.cleanupEmptySubdirs()

    return {
      deletedCount,
      freedBytes,
      remainingCount: this.recordings.length,
      stats: this.getStorageStats(),
    }
  }

  purgeDemoRecordings(): { deletedCount: number; freedBytes: number } {
    let deletedCount = 0
    let freedBytes = 0
    const keep: LocalRecordingItem[] = []
    const removedPaths = new Set<string>()

    for (const rec of this.recordings) {
      if (this.isDemoRecording(rec)) {
        removedPaths.add(path.resolve(rec.filePath).toLowerCase())
        if (rec.filePath && fs.existsSync(rec.filePath)) {
          try {
            fs.rmSync(rec.filePath, {
              force: true,
              maxRetries: 4,
              retryDelay: 150,
            })
          } catch {
            // ignore
          }
        }
        deletedCount++
        freedBytes += rec.sizeBytes
      } else {
        keep.push(rec)
      }
    }

    // Also remove any unindexed demo MP4 files on disk so rescanDirectory() never re-imports them
    for (const root of this.getAllStorageRoots()) {
      for (const fullPath of this.collectMp4FilesRecursive(root, 3)) {
        const key = path.resolve(fullPath).toLowerCase()
        if (removedPaths.has(key)) continue
        if (this.isDemoFilename(fullPath)) {
          try {
            const stat = fs.statSync(fullPath)
            fs.rmSync(fullPath, { force: true, maxRetries: 4, retryDelay: 150 })
            deletedCount++
            freedBytes += stat.size
          } catch {
            // ignore
          }
        }
      }
    }

    if (deletedCount > 0 || keep.length !== this.recordings.length) {
      this.recordings = keep
      this.rebuildLookupMaps()
      this.saveIndexDirty = true
      this.flushIndexSync()
      this.cleanupEmptySubdirs()
    }

    return { deletedCount, freedBytes }
  }

  exportRecording(id: string, destinationPath: string): string {
    const target = this.recordings.find((r) => r.id === id)
    if (!target || !fs.existsSync(target.filePath)) {
      throw new Error('Recording file no longer exists on disk')
    }
    fs.copyFileSync(target.filePath, destinationPath)
    return destinationPath
  }

  exportEvidenceBundle(
    id: string,
    destinationMp4Path: string,
  ): { videoPath: string; manifestPath: string; sha256: string } {
    const target = this.recordings.find((r) => r.id === id)
    if (!target || !fs.existsSync(target.filePath)) {
      throw new Error('Recording file no longer exists on disk')
    }
    fs.copyFileSync(target.filePath, destinationMp4Path)
    const fileBuf = fs.readFileSync(destinationMp4Path)
    const sha256 = crypto.createHash('sha256').update(fileBuf).digest('hex')
    const manifestPath = `${destinationMp4Path}.evidence.json`
    const manifest = {
      schema: 'ringwatch-evidence-bundle/v1',
      exportedAt: new Date().toISOString(),
      sha256,
      videoFileName: path.basename(destinationMp4Path),
      recording: {
        id: target.id,
        cameraId: target.cameraId,
        cameraName: target.cameraName,
        originalFileName: target.fileName,
        createdAt: target.createdAt,
        durationSeconds: target.durationSeconds,
        sizeBytes: target.sizeBytes,
        trigger: target.trigger,
        starred: Boolean(target.starred),
        notes: target.notes ?? '',
      },
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    return {
      videoPath: destinationMp4Path,
      manifestPath,
      sha256,
    }
  }

  importVideoFiles(sourcePaths: string[]): LocalRecordingItem[] {
    const dir = this.resolveClipDirectory('imported', new Date())
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
      const id = crypto.randomUUID()
      const item: LocalRecordingItem = {
        id,
        cameraId: 'imported-local',
        cameraName: 'Imported Video',
        filePath: destPath,
        fileName,
        createdAt: stat.mtime.toISOString(),
        durationSeconds: 30,
        sizeBytes: stat.size,
        trigger: 'imported',
        starred: false,
        playbackUrl: this.buildPlaybackUrl({ id, fileName }),
      }
      this.recordings.unshift(item)
      imported.push(item)
    }

    if (imported.length > 0) {
      this.saveIndex()
    }
    return imported
  }

  registerUploadedMp4(
    originalFileName: string,
    tempFilePath: string,
  ): LocalRecordingItem {
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('Uploaded file not found')
    }
    const dir = this.resolveClipDirectory('imported', new Date())
    const base = path.basename(originalFileName || 'imported.mp4')
    const safeName = base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'imported.mp4'
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
    try {
      fs.renameSync(tempFilePath, destPath)
    } catch {
      fs.copyFileSync(tempFilePath, destPath)
      try {
        fs.rmSync(tempFilePath, { force: true })
      } catch {
        // ignore cleanup
      }
    }
    const stat = fs.statSync(destPath)
    const id = crypto.randomUUID()
    const item: LocalRecordingItem = {
      id,
      cameraId: 'imported-local',
      cameraName: 'Imported Video',
      filePath: destPath,
      fileName,
      createdAt: new Date().toISOString(),
      durationSeconds: 30,
      sizeBytes: stat.size,
      trigger: 'imported',
      starred: false,
      playbackUrl: this.buildPlaybackUrl({ id, fileName }),
    }
    this.recordings.unshift(item)
    this.saveIndex()
    this.enforceRetentionAndQuota(undefined, undefined, item.id)
    return item
  }

  private collectMp4FilesRecursive(rootDir: string, maxDepth = 3): string[] {
    const results: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1)
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
          results.push(fullPath)
        }
      }
    }
    walk(rootDir, 0)
    return results
  }

  private cleanupEmptySubdirs(): void {
    const roots = this.getAllStorageRoots()
    const pruneDir = (dir: string, depth: number): boolean => {
      if (depth > 3) return false
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return false
      }
      let remaining = 0
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const removed = pruneDir(full, depth + 1)
          if (!removed) remaining++
        } else {
          remaining++
        }
      }
      if (depth > 0 && remaining === 0) {
        try {
          fs.rmdirSync(dir)
          return true
        } catch {
          return false
        }
      }
      return false
    }

    for (const root of roots) {
      pruneDir(root, 0)
    }
  }

  rescanDirectory(): { recordings: LocalRecordingItem[]; stats: StorageStats } {
    this.ensureRecordingsDir()
    const isLiveMode = this.configStore.getPublicSettings().mode === 'live'
    this.recordings = this.recordings.filter((r) => {
      if (!fs.existsSync(r.filePath)) return false
      if (isLiveMode && this.isDemoRecording(r)) return false
      return true
    })
    const indexedPaths = new Set(
      this.recordings.map((r) => path.resolve(r.filePath).toLowerCase()),
    )

    const roots = this.getAllStorageRoots()
    for (const root of roots) {
      const mp4Files = this.collectMp4FilesRecursive(root, 3)
      for (const fullPath of mp4Files) {
        const key = path.resolve(fullPath).toLowerCase()
        if (indexedPaths.has(key)) continue
        if (key.includes(`${path.sep}evidence-exports${path.sep}`)) continue

        let stat: fs.Stats
        try {
          stat = fs.statSync(fullPath)
        } catch {
          continue
        }
        if (stat.size < 2048) continue

        const fileName = path.basename(fullPath)
        if (isLiveMode && this.isDemoFilename(fileName)) continue
        const parts = fileName.split('_')
        const guessedCam = parts[0]?.replace(/-/g, ' ') || 'Local Camera'
        const titleCam = guessedCam.replace(/\b\w/g, (m) => m.toUpperCase())
        const inferredTrigger: LocalRecordingItem['trigger'] =
          parts[1] === 'continuous'
            ? 'continuous'
            : parts[1] === 'motion'
              ? 'motion'
              : parts[1] === 'ding'
                ? 'ding'
                : parts[1] === 'package'
                  ? 'package'
                  : 'imported'

        this.recordings.push({
          id: crypto.randomUUID(),
          cameraId: 'local-disk',
          cameraName: titleCam,
          filePath: fullPath,
          fileName,
          createdAt: stat.mtime.toISOString(),
          durationSeconds:
            inferredTrigger === 'continuous'
              ? this.configStore.getPublicSettings().continuousSegmentSeconds
              : 30,
          sizeBytes: stat.size,
          trigger: inferredTrigger,
          starred: false,
        })
        indexedPaths.add(key)
      }
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

  private resolveEffectiveDiskThresholds(
    totalDiskBytes: number | null,
    hasFreeOverride: boolean,
  ): { minFreeBytes: number; lowWarnBytes: number } {
    const settings = this.configStore.getPublicSettings()
    const rawMin = settings.minFreeDiskGb * BYTES_PER_GB
    const rawWarn = settings.lowDiskWarningGb * BYTES_PER_GB
    if (hasFreeOverride || !totalDiskBytes || totalDiskBytes <= 0) {
      return { minFreeBytes: rawMin, lowWarnBytes: rawWarn }
    }
    const minFreeBytes = Math.min(rawMin, Math.floor(totalDiskBytes * 0.2))
    const lowWarnBytes = Math.max(
      minFreeBytes,
      Math.min(rawWarn, Math.floor(totalDiskBytes * 0.35)),
    )
    return { minFreeBytes, lowWarnBytes }
  }

  enforceRetentionAndQuota(
    overrideMaxBytes?: number,
    overrideFreeDiskBytes?: number,
    protectClipId?: string,
  ): {
    prunedCount: number
    freedBytes: number
    stats: StorageStats
  } {
    const settings = this.configStore.getPublicSettings()
    const resolved = this.resolveActiveStorageDir()
    let prunedCount = 0
    let freedBytes = 0

    // 1. Delete expired unstarred recordings older than retentionDays
    if (settings.retentionDays > 0) {
      const cutoffMs = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000
      const keep: LocalRecordingItem[] = []
      for (const rec of this.recordings) {
        const createdMs = new Date(rec.createdAt).getTime()
        if (!rec.starred && rec.id !== protectClipId && createdMs < cutoffMs) {
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
          ? settings.maxStorageGb * BYTES_PER_GB
          : 0

    if (maxBytes > 0) {
      let totalBytes = this.recordings.reduce((sum, r) => sum + r.sizeBytes, 0)
      if (totalBytes > maxBytes) {
        const oldestUnstarred = [...this.recordings]
          .filter((r) => !r.starred && r.id !== protectClipId)
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

    // 3. Enforce Free-Disk Floor ring buffer (auto-recycle oldest unstarred clips if disk free space < effective minFreeBytes)
    const disk = this.getDiskSpace(resolved.activeDir)
    const { minFreeBytes } = this.resolveEffectiveDiskThresholds(
      disk.totalBytes,
      overrideFreeDiskBytes !== undefined,
    )
    let currentFreeBytes =
      overrideFreeDiskBytes !== undefined ? overrideFreeDiskBytes : disk.freeBytes

    if (currentFreeBytes !== null && currentFreeBytes < minFreeBytes) {
      const oldestUnstarred = [...this.recordings]
        .filter((r) => !r.starred && r.id !== protectClipId)
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )

      const toRemove = new Set<string>()
      for (const candidate of oldestUnstarred) {
        if (currentFreeBytes >= minFreeBytes) break
        toRemove.add(candidate.id)
        if (fs.existsSync(candidate.filePath)) {
          try {
            fs.unlinkSync(candidate.filePath)
          } catch {
            // ignore unlink error
          }
        }
        currentFreeBytes += candidate.sizeBytes
        prunedCount++
        freedBytes += candidate.sizeBytes
      }

      if (toRemove.size > 0) {
        this.recordings = this.recordings.filter((r) => !toRemove.has(r.id))
      }
    }

    if (prunedCount > 0) {
      this.saveIndex()
      this.cleanupEmptySubdirs()
    }

    const updatedFreeOverride =
      overrideFreeDiskBytes !== undefined ? overrideFreeDiskBytes + freedBytes : undefined

    return {
      prunedCount,
      freedBytes,
      stats: this.getStorageStats(updatedFreeOverride),
    }
  }

  private buildSlug(cameraName: string): string {
    return (
      cameraName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'camera'
    )
  }

  private buildFileName(cameraName: string, trigger: string, date = new Date()): string {
    const slug = this.buildSlug(cameraName)
    const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `${slug}_${trigger}_${stamp}.mp4`
  }

  createNvrSegmentTarget(cameraName: string, sessionDate = new Date()): NvrSegmentTarget {
    const dir = this.resolveClipDirectory(cameraName, sessionDate)
    const slug = this.buildSlug(cameraName)
    const stamp = sessionDate.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const suffix = crypto.randomBytes(2).toString('hex')
    const prefix = `${slug}_continuous_${stamp}_${suffix}`
    const segmentPattern = path.join(dir, `${prefix}_%04d.mp4`)

    const listDir = path.join(os.tmpdir(), 'ringwatch-nvr')
    fs.mkdirSync(listDir, { recursive: true, mode: 0o700 })
    const segmentListPath = path.join(listDir, `${prefix}.csv`)

    return {
      dir,
      prefix,
      segmentPattern,
      ffmpegSegmentPattern: segmentPattern.replace(/\\/g, '/'),
      segmentListPath,
      ffmpegSegmentListPath: segmentListPath.replace(/\\/g, '/'),
    }
  }

  registerRecordedSegment(params: {
    cameraId: string
    cameraName: string
    filePath: string
    createdAt: string
    durationSeconds: number
    trigger: LocalRecordingItem['trigger']
    thumbnailDataUrl?: string
  }): LocalRecordingItem | null {
    if (!fs.existsSync(params.filePath)) return null
    const stat = fs.statSync(params.filePath)
    if (stat.size < 2048) return null

    const normalizedPath = path.resolve(params.filePath).toLowerCase()
    const existing = this.recordingsByPath.get(normalizedPath)
    if (existing) {
      return {
        ...existing,
        playbackUrl: this.buildPlaybackUrl(existing),
      }
    }

    const id = crypto.randomUUID()
    const fileName = path.basename(params.filePath)
    const item: LocalRecordingItem = {
      id,
      cameraId: params.cameraId,
      cameraName: params.cameraName,
      filePath: params.filePath,
      fileName,
      createdAt: params.createdAt,
      durationSeconds: Math.max(1, Math.round(params.durationSeconds)),
      sizeBytes: stat.size,
      trigger: params.trigger,
      starred: false,
      ...(params.trigger !== 'continuous' && params.thumbnailDataUrl
        ? { thumbnailDataUrl: params.thumbnailDataUrl }
        : {}),
      playbackUrl: this.buildPlaybackUrl({ id, fileName }),
    }

    this.recordings.unshift(item)
    this.sortRecordingsDesc()
    this.saveIndex()
    this.enforceRetentionAndQuota(undefined, undefined, item.id)
    return item
  }

  async captureFromRingCamera(params: {
    cameraId: string
    cameraName: string
    camera: RecordableRingCamera
    durationSeconds: number
    trigger: LocalRecordingItem['trigger']
  }): Promise<LocalRecordingItem> {
    const startedAt = new Date()
    const dir = this.resolveClipDirectory(params.cameraName, startedAt)
    const fileName = this.buildFileName(params.cameraName, params.trigger, startedAt)
    const filePath = path.join(dir, fileName)

    let thumbnailDataUrl: string | undefined
    try {
      const snap = await params.camera.getSnapshot()
      thumbnailDataUrl = `data:image/jpeg;base64,${snap.toString('base64')}`
    } catch {
      // Battery cameras may block snapshots while recording
    }

    if (typeof params.camera.streamVideo === 'function') {
      const ffmpegPath = filePath.replace(/\\/g, '/')
      const liveCall = await params.camera.streamVideo({
        video: ['-vcodec', 'copy'],
        audio: ['-acodec', 'aac', '-b:a', '96k'],
        output: [
          '-t',
          String(params.durationSeconds),
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof',
          ffmpegPath,
        ],
      })
      await new Promise<void>((resolve) => {
        liveCall.onCallEnded.subscribe(() => resolve())
      })
    } else {
      await params.camera.recordToFile(filePath, params.durationSeconds)
    }

    const elapsedSeconds = Math.max(
      1,
      Math.min(
        params.durationSeconds,
        Math.round((Date.now() - startedAt.getTime()) / 1000),
      ),
    )

    if (!thumbnailDataUrl) {
      const frame = await this.extractJpegFrame(filePath)
      if (frame) {
        thumbnailDataUrl = `data:image/jpeg;base64,${frame.toString('base64')}`
      }
    }

    const stat = fs.statSync(filePath)
    const id = crypto.randomUUID()
    const item: LocalRecordingItem = {
      id,
      cameraId: params.cameraId,
      cameraName: params.cameraName,
      filePath,
      fileName,
      createdAt: startedAt.toISOString(),
      durationSeconds: elapsedSeconds,
      sizeBytes: stat.size,
      trigger: params.trigger,
      starred: false,
      thumbnailDataUrl,
      playbackUrl: this.buildPlaybackUrl({ id, fileName }),
    }

    this.recordings.unshift(item)
    this.recordings.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    this.saveIndex()
    this.enforceRetentionAndQuota(undefined, undefined, item.id)
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
    const now = new Date()
    const dir = this.resolveClipDirectory(params.cameraName, now)
    const fileName = this.buildFileName(params.cameraName, 'cloud', now)
    const filePath = path.join(dir, fileName)

    const recordingUrl = await params.camera.getRecordingUrl(params.dingId)
    let parsedUrl: URL
    try {
      parsedUrl = new URL(recordingUrl)
    } catch {
      throw new Error('Ring returned an invalid cloud recording URL')
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('Refused to download cloud recording over an insecure non-HTTPS URL')
    }

    const response = await fetch(parsedUrl.toString())
    if (!response.ok) {
      throw new Error(`Ring cloud download failed (HTTP ${response.status})`)
    }
    const arrayBuf = await response.arrayBuffer()
    fs.writeFileSync(filePath, Buffer.from(arrayBuf))

    const stat = fs.statSync(filePath)
    const id = crypto.randomUUID()
    const item: LocalRecordingItem = {
      id,
      cameraId: params.cameraId,
      cameraName: params.cameraName,
      filePath,
      fileName,
      createdAt: now.toISOString(),
      durationSeconds: params.durationSeconds,
      sizeBytes: stat.size,
      trigger: 'cloud-download',
      starred: false,
      thumbnailDataUrl: params.thumbnailDataUrl,
      playbackUrl: this.buildPlaybackUrl({ id, fileName }),
    }

    this.recordings.unshift(item)
    this.saveIndex()
    this.enforceRetentionAndQuota(undefined, undefined, item.id)
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
    const createdDate = params.createdAtOverride
      ? new Date(params.createdAtOverride)
      : new Date()
    const dir = this.resolveClipDirectory(params.cameraName, createdDate)
    const fileName = this.buildFileName(params.cameraName, params.trigger, createdDate)
    const filePath = path.join(dir, fileName)
    const tmpPath = `${filePath}.tmp`

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
        '-f',
        'mp4',
        tmpPath,
      ])
      fs.renameSync(tmpPath, filePath)
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true })
      } catch {
        // ignore cleanup
      }
      throw new Error(
        `FFmpeg is required to encode demo MP4 clips (${err instanceof Error ? err.message : String(err)})`,
      )
    }

    const stat = fs.statSync(filePath)
    const id = crypto.randomUUID()
    const item: LocalRecordingItem = {
      id,
      cameraId: params.cameraId,
      cameraName: params.cameraName,
      filePath,
      fileName,
      createdAt: createdDate.toISOString(),
      durationSeconds: params.durationSeconds,
      sizeBytes: stat.size,
      trigger: params.trigger,
      starred: Boolean(params.starred),
      notes: 'Demo sample clip',
      thumbnailDataUrl: params.thumbnailDataUrl,
      playbackUrl: this.buildPlaybackUrl({ id, fileName }),
    }

    this.recordings.unshift(item)
    this.saveIndex()
    this.enforceRetentionAndQuota(undefined, undefined, item.id)
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

  private runFfmpegJpegPipe(
    ffmpegBin: string,
    args: string[],
    timeoutMs = 8000,
  ): Promise<Buffer | null> {
    return new Promise((resolve) => {
      let settled = false
      const chunks: Buffer[] = []
      let totalBytes = 0

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(ffmpegBin, args, { windowsHide: true })
      } catch {
        resolve(null)
        return
      }

      const finish = (buf: Buffer | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(buf)
      }

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore kill failure
        }
        finish(null)
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes <= 12 * 1024 * 1024) {
          chunks.push(chunk)
        }
      })

      child.on('error', () => finish(null))
      child.on('close', (code) => {
        if (code !== 0 || chunks.length === 0) {
          finish(null)
          return
        }
        const out = Buffer.concat(chunks)
        if (out.length >= 256 && out[0] === 0xff && out[1] === 0xd8) {
          finish(out)
        } else {
          finish(null)
        }
      })
    })
  }

  async extractJpegFrame(videoPath: string): Promise<Buffer | null> {
    if (!videoPath || !fs.existsSync(videoPath)) return null
    try {
      const stat = fs.statSync(videoPath)
      if (!stat.isFile() || stat.size < 1024) return null
    } catch {
      return null
    }

    const ffmpegBin = this.resolveFfmpegBinary()

    // Attempt 1: seek near the end of the segment for the freshest frame
    const tailFrame = await this.runFfmpegJpegPipe(ffmpegBin, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-sseof',
      '-1',
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ])
    if (tailFrame) return tailFrame

    // Attempt 2: decode first available keyframe (handles short or non-seekable MPEG-TS segments)
    return this.runFfmpegJpegPipe(ffmpegBin, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ])
  }

  /**
   * Produces a high-detail cropped JPEG focused on the lower 68% ground/porch/walkway/driveway
   * delivery zone of a wide-angle Ring camera frame so small boxes and flat mailers appear
   * significantly larger to Cloud Vision models.
   */
  async createDeliveryZoneCrop(jpegBuffer: Buffer): Promise<Buffer | null> {
    if (!jpegBuffer || jpegBuffer.length < 1024) return null
    if (jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) return null

    const ffmpegBin = this.resolveFfmpegBinary()
    return new Promise((resolve) => {
      let settled = false
      const chunks: Buffer[] = []
      let totalBytes = 0

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(
          ffmpegBin,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'image2pipe',
            '-vcodec',
            'mjpeg',
            '-i',
            'pipe:0',
            '-vf',
            'crop=iw:trunc(ih*0.68/2)*2:0:trunc(ih*0.32/2)*2',
            '-frames:v',
            '1',
            '-q:v',
            '2',
            '-f',
            'image2pipe',
            '-vcodec',
            'mjpeg',
            'pipe:1',
          ],
          { windowsHide: true },
        )
      } catch {
        resolve(null)
        return
      }

      const finish = (buf: Buffer | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(buf)
      }

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        finish(null)
      }, 3500)

      child.stdout?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes <= 10 * 1024 * 1024) {
          chunks.push(chunk)
        }
      })

      child.on('error', () => finish(null))
      child.on('close', (code) => {
        if (code !== 0 || chunks.length === 0) {
          finish(null)
          return
        }
        const out = Buffer.concat(chunks)
        if (out.length >= 256 && out[0] === 0xff && out[1] === 0xd8) {
          finish(out)
        } else {
          finish(null)
        }
      })

      child.stdin?.on('error', () => {
        // Ignore EPIPE if ffmpeg exits early
      })
      try {
        child.stdin?.end(jpegBuffer)
      } catch {
        finish(null)
      }
    })
  }

  /**
   * Extract a tiny 64x36 grayscale luma frame (2,304 raw bytes) directly from a video segment
   * using keyframe-only decoding. Used for ultra-low-CPU local scene-change detection when
   * 24/7 NVR streaming prevents Ring cloud from emitting motion push notifications.
   */
  async extractMotionLumaGrid(videoPath: string): Promise<Buffer | null> {
    if (!videoPath || !fs.existsSync(videoPath)) return null
    try {
      const stat = fs.statSync(videoPath)
      if (!stat.isFile() || stat.size < 1024) return null
    } catch {
      return null
    }

    const ffmpegBin = this.resolveFfmpegBinary()
    const runProbe = (args: string[]): Promise<Buffer | null> =>
      new Promise((resolve) => {
        let settled = false
        const chunks: Buffer[] = []
        let totalBytes = 0

        let child: ReturnType<typeof spawn>
        try {
          child = spawn(ffmpegBin, args, { windowsHide: true })
        } catch {
          resolve(null)
          return
        }

        const finish = (buf: Buffer | null) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(buf)
        }

        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          finish(null)
        }, 3000)

        child.stdout?.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (totalBytes <= MOTION_GRID_PIXELS * 4) {
            chunks.push(chunk)
          }
        })

        child.on('error', () => finish(null))
        child.on('close', (code) => {
          if (code !== 0 || chunks.length === 0) {
            finish(null)
            return
          }
          const out = Buffer.concat(chunks)
          if (out.length >= MOTION_GRID_PIXELS) {
            finish(out.subarray(0, MOTION_GRID_PIXELS))
          } else {
            finish(null)
          }
        })
      })

    const keyframeGrid = await runProbe([
      '-hide_banner',
      '-loglevel',
      'error',
      '-skip_frame',
      'nokey',
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${MOTION_GRID_WIDTH}:${MOTION_GRID_HEIGHT},format=gray`,
      '-f',
      'rawvideo',
      'pipe:1',
    ])
    if (keyframeGrid) return keyframeGrid

    return runProbe([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${MOTION_GRID_WIDTH}:${MOTION_GRID_HEIGHT},format=gray`,
      '-f',
      'rawvideo',
      'pipe:1',
    ])
  }

  /**
   * Extract a 64x36 grayscale luma grid directly from an in-memory JPEG snapshot buffer.
   * Used by AiPackageService's zero-cost persistent-change gate to skip Cloud Vision API
   * calls when a post-motion snapshot still matches the confirmed empty-porch baseline.
   */
  async extractLumaGridFromJpegBuffer(jpegBuffer: Buffer): Promise<Buffer | null> {
    if (!jpegBuffer || jpegBuffer.length < 256) return null
    if (jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) return null

    const ffmpegBin = this.resolveFfmpegBinary()
    return new Promise((resolve) => {
      let settled = false
      const chunks: Buffer[] = []
      let totalBytes = 0

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(
          ffmpegBin,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'image2pipe',
            '-vcodec',
            'mjpeg',
            '-i',
            'pipe:0',
            '-frames:v',
            '1',
            '-vf',
            `scale=${MOTION_GRID_WIDTH}:${MOTION_GRID_HEIGHT},format=gray`,
            '-f',
            'rawvideo',
            'pipe:1',
          ],
          { windowsHide: true },
        )
      } catch {
        resolve(null)
        return
      }

      const finish = (buf: Buffer | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(buf)
      }

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        finish(null)
      }, 3000)

      child.stdout?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes <= MOTION_GRID_PIXELS * 4) {
          chunks.push(chunk)
        }
      })

      child.on('error', () => finish(null))
      child.on('close', (code) => {
        if (code !== 0 || chunks.length === 0) {
          finish(null)
          return
        }
        const out = Buffer.concat(chunks)
        if (out.length >= MOTION_GRID_PIXELS) {
          finish(out.subarray(0, MOTION_GRID_PIXELS))
        } else {
          finish(null)
        }
      })

      child.stdin?.on('error', () => {
        // Ignore EPIPE
      })
      try {
        child.stdin?.end(jpegBuffer)
      } catch {
        finish(null)
      }
    })
  }

  resolveFfmpegBinary(): string {
    const custom = this.configStore.getPublicSettings().ffmpegPath
    if (custom && !custom.includes('\0')) {
      try {
        if (fs.existsSync(custom) && fs.statSync(custom).isFile()) {
          return custom
        }
      } catch {
        // Ignore invalid custom path and fall back to bundled binary
      }
    }
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
