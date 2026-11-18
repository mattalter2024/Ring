import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigStore, type SecretCryptoAdapter } from '../electron/services/configStore'
import {
  AiPackageService,
  parseVisionResponse,
  type SnapshotSource,
} from '../electron/services/aiPackageService'
import { StreamService } from '../electron/services/streamService'
import { RecordingService } from '../electron/services/recordingService'
import type { NotificationService } from '../electron/services/notificationService'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ringwatch-test-'))
}

describe('ConfigStore', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('encrypts secrets via DPAPI adapter and never exposes raw keys publicly', () => {
    const mockDpapi: SecretCryptoAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: (v) => Buffer.from(`enc:${v}`, 'utf-8'),
      decryptString: (b) => b.toString('utf-8').replace(/^enc:/, ''),
    }

    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'), mockDpapi)
    store.setRingRefreshToken('ring_refresh_secret_123')
    store.updateSettings({
      packageAi: {
        provider: 'gemini',
        openaiApiKey: 'sk-test-openai',
        geminiApiKey: 'AIza-test-gemini',
        minConfidence: 0.8,
      },
    })

    const pub = store.getPublicSettings()
    expect(pub.hasRingToken).toBe(true)
    expect(pub.packageAi.hasOpenaiKey).toBe(true)
    expect(pub.packageAi.hasGeminiKey).toBe(true)
    expect(JSON.stringify(pub)).not.toContain('sk-test-openai')
    expect(JSON.stringify(pub)).not.toContain('AIza-test-gemini')
    expect(JSON.stringify(pub)).not.toContain('ring_refresh_secret_123')

    // Reload from disk and confirm decryption works
    const reloaded = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'), mockDpapi)
    expect(reloaded.getRingRefreshToken()).toBe('ring_refresh_secret_123')
    expect(reloaded.getOpenaiApiKey()).toBe('sk-test-openai')
    expect(reloaded.getGeminiApiKey()).toBe('AIza-test-gemini')
    expect(reloaded.getPublicSettings().packageAi.provider).toBe('gemini')
  })
})

describe('parseVisionResponse', () => {
  it('parses markdown-fenced JSON and normalizes percentage confidence', () => {
    const raw = '```json\n{"packageDetected": true, "confidence": 94, "packageCount": 2, "carrierHint": "UPS", "placement": "Front steps", "personPresent": false, "summary": "Two UPS boxes on the front steps."}\n```'
    const parsed = parseVisionResponse(raw)
    expect(parsed.packageDetected).toBe(true)
    expect(parsed.confidence).toBeCloseTo(0.94, 4)
    expect(parsed.packageCount).toBe(2)
    expect(parsed.carrierHint).toBe('UPS')
    expect(parsed.placement).toBe('Front steps')
  })

  it('forces packageCount to 0 when packageDetected is false', () => {
    const parsed = parseVisionResponse(
      JSON.stringify({
        packageDetected: false,
        confidence: 0.91,
        packageCount: 3,
        carrierHint: '',
        placement: null,
        personPresent: true,
        summary: 'No parcels visible; mail carrier walking away.',
      }),
    )
    expect(parsed.packageDetected).toBe(false)
    expect(parsed.packageCount).toBe(0)
    expect(parsed.carrierHint).toBeNull()
    expect(parsed.personPresent).toBe(true)
  })
})

describe('AiPackageService automation & Vision providers', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls OpenAI Vision, notifies Windows + sound, and enforces cooldown on repeated motion', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    store.updateSettings({
      mode: 'live',
      packageAi: {
        enabled: true,
        provider: 'openai',
        openaiApiKey: 'sk-mock-key',
        minConfidence: 0.7,
        cooldownMinutes: 10,
        monitoredCameraIds: ['cam-front'],
      },
    })

    const notifySpy = vi.fn()
    const mockNotifications = {
      notifyPackageAlert: notifySpy,
    } as unknown as NotificationService
    const eventSpy = vi.fn()
    const detectionSpy = vi.fn()

    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: mockNotifications,
      onDetection: detectionSpy,
      onSecurityEvent: eventSpy,
    })

    const fakeSnapshotSource: SnapshotSource = {
      getCameraMeta: (id) =>
        id === 'cam-front' ? { id, name: 'Front Door' } : undefined,
      listCameraIds: () => ['cam-front'],
      captureSnapshotBase64: async () => ({
        base64: Buffer.from('fake-jpeg').toString('base64'),
        dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn',
      }),
    }
    service.attachSnapshotSource(fakeSnapshotSource)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  packageDetected: true,
                  confidence: 0.93,
                  packageCount: 1,
                  carrierHint: 'Amazon',
                  placement: 'Left of front door',
                  personPresent: false,
                  summary: 'Amazon box placed left of the front door.',
                }),
              },
            },
          ],
        }),
      }),
    )

    // Unmonitored camera ignored
    expect(await service.handleAutoTrigger('cam-back', 'motion')).toBeNull()

    // First motion trigger fires alert
    const first = await service.handleAutoTrigger('cam-front', 'motion')
    expect(first?.packageDetected).toBe(true)
    expect(first?.notified).toBe(true)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(eventSpy).toHaveBeenCalledTimes(1)

    // Second motion trigger within 10m cooldown still scans, but suppresses duplicate notification
    const second = await service.handleAutoTrigger('cam-front', 'motion')
    expect(second?.packageDetected).toBe(true)
    expect(second?.notified).toBe(false)
    expect(notifySpy).toHaveBeenCalledTimes(1)

    service.stop()
  })
})

describe('RecordingService & StreamService HTTP range playback', () => {
  let tmpDir: string
  let streamService: StreamService

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    streamService?.stopAll()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('captures a real demo MP4 clip with FFmpeg and serves 206 Partial Content over loopback', async () => {
    const recDir = path.join(tmpDir, 'recordings')
    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    await streamService.startServer()

    const recService = new RecordingService(tmpDir, store, streamService)
    const sampleImg = path.resolve(__dirname, '..', 'public', 'demo', 'front_porch.jpg')

    const item = await recService.captureDemoRecording({
      cameraId: 'demo-cam-front',
      cameraName: 'Front Porch Doorbell Pro',
      durationSeconds: 4,
      trigger: 'manual',
      sourceImagePath: sampleImg,
      thumbnailDataUrl: 'data:image/jpeg;base64,abc',
    })

    expect(fs.existsSync(item.filePath)).toBe(true)
    expect(item.sizeBytes).toBeGreaterThan(1000)
    expect(item.playbackUrl).toContain('http://127.0.0.1:')

    // Verify HTTP Range request works for HTML5 video seeking
    const res = await fetch(item.playbackUrl!, {
      headers: { Range: 'bytes=0-1023' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    const chunk = await res.arrayBuffer()
    expect(chunk.byteLength).toBe(1024)

    recService.deleteRecording(item.id)
    expect(fs.existsSync(item.filePath)).toBe(false)
    expect(recService.listRecordings()).toHaveLength(0)
  })
})

describe('Local Video Storage quota, star protection & disk rescan', () => {
  let tmpDir: string
  let streamService: StreamService

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    streamService?.stopAll()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rescans MP4 files on disk and preserves starred clips during quota pruning', async () => {
    const recDir = path.join(tmpDir, 'vault')
    fs.mkdirSync(recDir, { recursive: true })
    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    await streamService.startServer()

    // Create 3 local MP4 files of 4KB each with staggered timestamps
    const f1 = path.join(recDir, 'front-porch_motion_2026-11-18T10-00-00.mp4')
    const f2 = path.join(recDir, 'driveway_motion_2026-11-18T11-00-00.mp4')
    const f3 = path.join(recDir, 'back-patio_motion_2026-11-18T12-00-00.mp4')
    fs.writeFileSync(f1, Buffer.alloc(4096, 1))
    fs.writeFileSync(f2, Buffer.alloc(4096, 2))
    fs.writeFileSync(f3, Buffer.alloc(4096, 3))

    const now = Date.now()
    fs.utimesSync(f1, new Date(now - 3 * 3600 * 1000), new Date(now - 3 * 3600 * 1000))
    fs.utimesSync(f2, new Date(now - 2 * 3600 * 1000), new Date(now - 2 * 3600 * 1000))
    fs.utimesSync(f3, new Date(now - 1 * 3600 * 1000), new Date(now - 1 * 3600 * 1000))

    const recService = new RecordingService(tmpDir, store, streamService)
    const rescanned = recService.rescanDirectory()
    expect(rescanned.recordings).toHaveLength(3)
    expect(rescanned.stats.totalBytes).toBe(4096 * 3)

    // Star/protect the oldest clip (f1) so quota pruning must delete f2 instead!
    const oldest = rescanned.recordings.find((r) => r.filePath === f1)!
    recService.toggleStar(oldest.id)

    // Enforce 8KB cap -> must prune 1 unstarred clip (f2), keeping starred f1 and newest f3
    const pruned = recService.enforceRetentionAndQuota(8192)
    expect(pruned.prunedCount).toBe(1)
    expect(pruned.freedBytes).toBe(4096)
    expect(fs.existsSync(f1)).toBe(true)
    expect(fs.existsSync(f2)).toBe(false)
    expect(fs.existsSync(f3)).toBe(true)
    expect(pruned.stats.starredClips).toBe(1)
  })
})

describe('Timeline Tool scrubbing helpers', async () => {
  const {
    computeVisibleWindow,
    findClipAtTimestamp,
    findNearestTimelineStop,
    buildRulerTicks,
  } = await import('../src/utils/timeline')

  it('clamps visible zoom window and locates clips and nearest events accurately', () => {
    const dayStart = new Date(2026, 10, 18, 0, 0, 0).getTime()
    const dayEnd = new Date(2026, 10, 18, 24, 0, 0).getTime()

    const win = computeVisibleWindow(
      dayStart,
      dayEnd,
      dayStart + 30 * 60 * 1000,
      6,
    )
    expect(win.windowStartMs).toBe(dayStart)
    expect(win.windowEndMs).toBe(dayStart + 6 * 3600 * 1000)

    const ticks = buildRulerTicks(win.windowStartMs, win.windowEndMs, 6)
    expect(ticks.length).toBeGreaterThanOrEqual(10)

    const clipStart = dayStart + 2 * 3600 * 1000
    const clips = [
      {
        id: 'c1',
        cameraId: 'cam-1',
        cameraName: 'Front Porch',
        filePath: '/tmp/c1.mp4',
        fileName: 'c1.mp4',
        createdAt: new Date(clipStart).toISOString(),
        durationSeconds: 60,
        sizeBytes: 2048,
        trigger: 'motion' as const,
      },
    ]

    const hit = findClipAtTimestamp(clips, clipStart + 25_000, 'cam-1')
    expect(hit?.clip.id).toBe('c1')
    expect(hit?.offsetSeconds).toBe(25)

    const nextStop = findNearestTimelineStop(clips, [], dayStart + 3600 * 1000, 'next')
    expect(nextStop).toBe(clipStart)
  })
})
