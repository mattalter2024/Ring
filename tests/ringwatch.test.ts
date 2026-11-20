import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
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
import {
  computeLumaSceneChange,
  MOTION_GRID_PIXELS,
  RecordingService,
} from '../electron/services/recordingService'
import { RingService } from '../electron/services/ringService'
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

    // Confirm ringSystemId is generated once and persisted across restarts
    const sysId1 = reloaded.getRingSystemId()
    expect(sysId1).toMatch(/^[0-9a-f-]{36}$/i)
    const reloadedAgain = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'), mockDpapi)
    expect(reloadedAgain.getRingSystemId()).toBe(sysId1)
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

  it('auto-migrates retired Gemini 2.5 models, skips thinking parts, and recovers from 404 suggestions', async () => {
    // Seed a legacy config file with deprecated gemini-2.5-pro
    fs.writeFileSync(
      path.join(tmpDir, 'ringwatch-config.json'),
      JSON.stringify({
        mode: 'live',
        packageAi: {
          enabled: true,
          provider: 'gemini',
          geminiModel: 'gemini-2.5-pro',
        },
        secretsPlain: { geminiApiKey: 'AIza-mock-gemini' },
      }),
      'utf-8',
    )

    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    // Automatically migrated on load
    expect(store.getPublicSettings().packageAi.geminiModel).toBe(
      'gemini-3.1-pro-preview',
    )

    // Test runtime 404 self-healing if a future model gets retired
    store.updateSettings({
      packageAi: { geminiModel: 'gemini-9.9-retired-preview' },
    })

    const mockNotifications = {
      notifyPackageAlert: vi.fn(),
    } as unknown as NotificationService
    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: mockNotifications,
      onDetection: vi.fn(),
      onSecurityEvent: vi.fn(),
    })
    service.attachSnapshotSource({
      getCameraMeta: (id) => ({ id, name: 'Front Door' }),
      listCameraIds: () => ['cam-front'],
      captureSnapshotBase64: async () => ({
        base64: Buffer.from('fake-jpeg').toString('base64'),
        dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn',
      }),
    })

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers['x-goog-api-key']).toBe('AIza-mock-gemini')
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        generationConfig?: Record<string, unknown>
      }
      // Deprecated temperature must not be sent on Gemini 3.x / 4 requests
      expect(body.generationConfig?.temperature).toBeUndefined()

      if (url.includes('gemini-9.9-retired-preview')) {
        return {
          ok: false,
          status: 404,
          text: async () =>
            JSON.stringify({
              error: {
                code: 404,
                message:
                  'This model models/gemini-9.9-retired-preview is no longer available. Please update your code to use models/gemini-3.1-pro-preview.',
              },
            }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'Let me check the welcome mat carefully...' },
                  {
                    text: JSON.stringify({
                      packageDetected: true,
                      confidence: 0.91,
                      packageCount: 1,
                      carrierHint: 'UPS',
                      placement: 'Front doorstep',
                      personPresent: false,
                      summary: 'One UPS parcel visible on the front doorstep.',
                    }),
                  },
                ],
              },
            },
          ],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.scanCamera('cam-front', 'manual')
    expect(result.rawError).toBeUndefined()
    expect(result.packageDetected).toBe(true)
    expect(result.carrierHint).toBe('UPS')
    expect(result.model).toBe('gemini-3.1-pro-preview')
    // Persisted fallback model to configStore
    expect(store.getPublicSettings().packageAi.geminiModel).toBe(
      'gemini-3.1-pro-preview',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)

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
    computeZoomedWindowCenter,
    panWindowCenter,
    findClipAtTimestamp,
    findNearestTimelineStop,
    buildRulerTicks,
    msToPercent,
    formatZoomLabel,
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

  it('keeps cursor timestamp anchored when zooming and clamps panning within the day', () => {
    const dayStart = new Date(2026, 10, 18, 0, 0, 0).getTime()
    const dayEnd = new Date(2026, 10, 18, 24, 0, 0).getTime()

    // Anchor 12:30 at 75% across the viewport when zooming from 6h down to 15m (0.25h)
    const anchorTs = dayStart + 12.5 * 3600 * 1000
    const nextCenter = computeZoomedWindowCenter(dayStart, dayEnd, anchorTs, 75, 0.25)
    const zoomedWin = computeVisibleWindow(dayStart, dayEnd, nextCenter, 0.25)
    expect(msToPercent(anchorTs, zoomedWin.windowStartMs, zoomedWin.windowEndMs)).toBeCloseTo(
      75,
      3,
    )

    // Fine zoom ticks and labels work for 15m and 30m levels
    expect(formatZoomLabel(0.25)).toBe('15m')
    expect(formatZoomLabel(0.5)).toBe('30m')
    expect(formatZoomLabel(1)).toBe('1h')
    const fineTicks = buildRulerTicks(zoomedWin.windowStartMs, zoomedWin.windowEndMs, 0.25)
    expect(fineTicks.length).toBeGreaterThanOrEqual(7)

    // Panning clamps cleanly at start and end of day
    const pannedStart = panWindowCenter(dayStart, dayEnd, nextCenter, 1, -24 * 3600 * 1000)
    expect(pannedStart).toBe(dayStart + 0.5 * 3600 * 1000)
    const pannedEnd = panWindowCenter(dayStart, dayEnd, nextCenter, 1, 24 * 3600 * 1000)
    expect(pannedEnd).toBe(dayEnd - 0.5 * 3600 * 1000)
  })
})

describe('Continuous All-Camera NVR Recording', () => {
  let tmpDir: string
  let streamService: StreamService

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    streamService?.stopAll()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists and clamps Continuous NVR settings across reloads', () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    const defaults = store.getPublicSettings()
    expect(defaults.continuousSegmentSeconds).toBe(120)
    expect(defaults.continuousSkipBatteryCams).toBe(false)
    expect(defaults.continuousAutoStart).toBe(true)
    expect(defaults.continuousCameraIds).toEqual([])
    expect(defaults.organizeByDateFolder).toBe(true)
    expect(defaults.preventSleepWhileRecording).toBe(true)
    expect(defaults.nvrNotificationsEnabled).toBe(true)

    store.updateSettings({
      continuousSegmentSeconds: 10, // clamped to 30
      continuousSkipBatteryCams: true,
      continuousAutoStart: false,
      continuousCameraIds: ['cam-a', 'cam-b'],
    })

    const reloaded = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    const pub = reloaded.getPublicSettings()
    expect(pub.continuousSegmentSeconds).toBe(30)
    expect(pub.continuousSkipBatteryCams).toBe(true)
    expect(pub.continuousAutoStart).toBe(false)
    expect(pub.continuousCameraIds).toEqual(['cam-a', 'cam-b'])
  })

  it('registers NVR segments with deduplication, skips tiny/corrupt files, and infers continuous trigger on rescan', async () => {
    const recDir = path.join(tmpDir, 'nvr')
    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    await streamService.startServer()

    const recService = new RecordingService(tmpDir, store, streamService)
    const target = recService.createNvrSegmentTarget('Front Porch')
    expect(target.dir.startsWith(recDir)).toBe(true)
    expect(target.dir).toMatch(/\d{4}-\d{2}-\d{2}[\\/]front-porch$/)
    expect(target.segmentPattern).toContain('_continuous_')
    expect(target.segmentListPath).toContain('.csv')

    const tinyPath = path.join(target.dir, `${target.prefix}_0000.mp4`)
    fs.writeFileSync(tinyPath, Buffer.alloc(512, 0))
    const skipped = recService.registerRecordedSegment({
      cameraId: 'cam-1',
      cameraName: 'Front Porch',
      filePath: tinyPath,
      createdAt: new Date().toISOString(),
      durationSeconds: 120,
      trigger: 'continuous',
    })
    expect(skipped).toBeNull()

    const validPath = path.join(target.dir, `${target.prefix}_0001.mp4`)
    fs.writeFileSync(validPath, Buffer.alloc(8192, 7))
    const startedIso = new Date(Date.now() - 120_000).toISOString()

    const reg1 = recService.registerRecordedSegment({
      cameraId: 'cam-1',
      cameraName: 'Front Porch',
      filePath: validPath,
      createdAt: startedIso,
      durationSeconds: 120,
      trigger: 'continuous',
    })
    expect(reg1).not.toBeNull()
    expect(reg1!.trigger).toBe('continuous')
    expect(reg1!.createdAt).toBe(startedIso)

    // Duplicate registration of same path must return existing item without duplicating
    const reg2 = recService.registerRecordedSegment({
      cameraId: 'cam-1',
      cameraName: 'Front Porch',
      filePath: validPath,
      createdAt: startedIso,
      durationSeconds: 120,
      trigger: 'continuous',
    })
    expect(reg2?.id).toBe(reg1?.id)
    expect(recService.listRecordings()).toHaveLength(1)

    // Rescanning disk recursively on a fresh RecordingService infers 'continuous' trigger & skips tiny files
    const freshService = new RecordingService(
      path.join(tmpDir, 'fresh-index'),
      store,
      streamService,
    )
    const rescanned = freshService.rescanDirectory()
    expect(rescanned.recordings).toHaveLength(1)
    expect(rescanned.recordings[0].trigger).toBe('continuous')
  })

  it('reuses active NVR HLS feed for Live View without opening a second Ring WebRTC call', async () => {
    const recDir = path.join(tmpDir, 'nvr-hls')
    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    await streamService.startServer()

    const prepared = await streamService.prepareNvrHlsOutput('cam-99')
    expect(fs.existsSync(prepared.dirPath)).toBe(true)

    // Simulate FFmpeg writing an HLS playlist with a segment
    fs.writeFileSync(
      prepared.playlistPath,
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg_00000.ts\n',
    )
    streamService.registerNvrHlsFeed('cam-99', prepared)

    const mockStreamVideo = vi.fn()
    const session = await streamService.startRingHlsStream('cam-99', {
      streamVideo: mockStreamVideo,
    })

    expect(mockStreamVideo).not.toHaveBeenCalled()
    expect(session.cameraId).toBe('cam-99')
    expect(session.streamUrl).toBe(prepared.streamUrl)
    expect(streamService.isStreaming('cam-99')).toBe(true)

    // Closing Live View stops the viewer session without tearing down the underlying NVR feed
    streamService.stopStream('cam-99')
    expect(streamService.isStreaming('cam-99')).toBe(false)

    // Reopening Live View still reuses the NVR feed with zero extra Ring call
    const session2 = await streamService.startRingHlsStream('cam-99', {
      streamVideo: mockStreamVideo,
    })
    expect(mockStreamVideo).not.toHaveBeenCalled()
    expect(session2.streamUrl).toBe(prepared.streamUrl)

    // Unregistering NVR feed ends the live viewer session cleanly
    const onEnded = vi.fn()
    streamService.stopStream('cam-99')
    await streamService.startRingHlsStream('cam-99', { streamVideo: mockStreamVideo }, onEnded)
    streamService.unregisterNvrHlsFeed('cam-99')
    expect(streamService.isStreaming('cam-99')).toBe(false)
    expect(onEnded).toHaveBeenCalledTimes(1)
  })
})

describe('Autonomous 24/7 UNVR & Storage Management', () => {
  let tmpDir: string
  let streamService: StreamService

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    streamService?.stopAll()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('auto-migrates v1 configs to v2 autonomous 24/7 defaults and clamps disk thresholds', () => {
    const configPath = path.join(tmpDir, 'config.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mode: 'live',
        continuousAutoStart: false,
        maxStorageGb: 25,
      }),
    )

    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    const migrated = store.getPublicSettings()
    expect(migrated.continuousAutoStart).toBe(true)
    expect(migrated.preventSleepWhileRecording).toBe(true)
    expect(migrated.nvrNotificationsEnabled).toBe(true)
    expect(migrated.organizeByDateFolder).toBe(true)
    expect(migrated.launchAtLogin).toBe(true)

    // Updating minFreeDiskGb above lowDiskWarningGb automatically raises lowDiskWarningGb >= minFreeDiskGb
    const updated = store.updateSettings({
      minFreeDiskGb: 40,
      lowDiskWarningGb: 15,
      maxStorageGb: 50000, // clamped to 20000
    })
    expect(updated.minFreeDiskGb).toBe(40)
    expect(updated.lowDiskWarningGb).toBe(40)
    expect(updated.maxStorageGb).toBe(20000)

    // If user explicitly turns continuousAutoStart off in v2, reload preserves their choice
    store.updateSettings({ continuousAutoStart: false })
    const reloaded = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    expect(reloaded.getPublicSettings().continuousAutoStart).toBe(false)
  })

  it('fails over automatically to failover storage when primary external mount is offline', async () => {
    const defaultDir = path.join(tmpDir, 'default-videos')
    const failoverDir = path.join(tmpDir, 'failover-usb')
    fs.mkdirSync(failoverDir, { recursive: true })

    const offlinePrimaryPath =
      process.platform === 'win32'
        ? `${
            ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'].find(
              (l) => !fs.existsSync(`${l}:\\`),
            ) ?? 'Z'
          }:\\RingWatch`
        : '/mnt/unplugged-ringwatch-external-drive/RingWatch'

    const store = new ConfigStore(tmpDir, defaultDir)
    store.updateSettings({
      recordingsDir: offlinePrimaryPath,
      failoverRecordingsDir: failoverDir,
    })

    streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    await streamService.startServer()
    const recService = new RecordingService(tmpDir, store, streamService)

    const resolved = recService.resolveActiveStorageDir()
    expect(resolved.primaryOnline).toBe(false)
    expect(resolved.usingFailover).toBe(true)
    expect(resolved.activeDir).toBe(failoverDir)

    // Segments created during failover land under failoverDir
    const target = recService.createNvrSegmentTarget('Driveway Cam')
    expect(target.dir.startsWith(failoverDir)).toBe(true)

    // Restoring primary directory switches back seamlessly
    const restoredPrimary = path.join(tmpDir, 'primary-restored')
    fs.mkdirSync(restoredPrimary, { recursive: true })
    store.updateSettings({ recordingsDir: restoredPrimary })
    const afterRestore = recService.resolveActiveStorageDir()
    expect(afterRestore.primaryOnline).toBe(true)
    expect(afterRestore.usingFailover).toBe(false)
    expect(afterRestore.activeDir).toBe(restoredPrimary)
  })

  it('serves date-folder MP4 recordings with HTTP 206 Range via /recording-id/<id>', async () => {
    const recDir = path.join(tmpDir, 'vault')
    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => [recDir])
    await streamService.startServer()

    const recService = new RecordingService(tmpDir, store, streamService)
    const target = recService.createNvrSegmentTarget('Back Patio')
    const payload = Buffer.alloc(16_384, 0x42)
    const mp4Path = path.join(target.dir, `${target.prefix}_0001.mp4`)
    fs.writeFileSync(mp4Path, payload)

    const item = recService.registerRecordedSegment({
      cameraId: 'cam-patio',
      cameraName: 'Back Patio',
      filePath: mp4Path,
      createdAt: new Date().toISOString(),
      durationSeconds: 120,
      trigger: 'continuous',
    })

    expect(item?.playbackUrl).toContain('/recording-id/')
    const res = await fetch(item!.playbackUrl!, {
      headers: { Range: 'bytes=0-1023' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-1023/16384')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.length).toBe(1024)
    expect(buf[0]).toBe(0x42)
  })

  it('enforces free-disk floor ring-buffer pruning while protecting starred clips and reporting disk health', async () => {
    const recDir = path.join(tmpDir, 'floor-vault')
    const store = new ConfigStore(tmpDir, recDir)
    store.updateSettings({
      maxStorageGb: 0, // unlimited quota; rely on free-disk floor
      retentionDays: 0,
      lowDiskWarningGb: 20,
      minFreeDiskGb: 10,
      organizeByDateFolder: false,
    })

    streamService = new StreamService(() => recDir)
    await streamService.startServer()
    const recService = new RecordingService(tmpDir, store, streamService)

    const makeClip = (name: string, ageMinutes: number, bytes: number) => {
      const p = path.join(recDir, name)
      fs.mkdirSync(recDir, { recursive: true })
      fs.writeFileSync(p, Buffer.alloc(bytes, 1))
      return recService.registerRecordedSegment({
        cameraId: 'cam-front',
        cameraName: 'Front Door',
        filePath: p,
        createdAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
        durationSeconds: 120,
        trigger: 'continuous',
      })!
    }

    const oldestStarred = makeClip('clip_01.mp4', 90, 20_000)
    const oldUnprotected = makeClip('clip_02.mp4', 60, 20_000)
    const newestUnprotected = makeClip('clip_03.mp4', 10, 20_000)
    recService.toggleStar(oldestStarred.id)

    // Simulate critically low free disk space (below 10 GB floor by 25 KB)
    const GB = 1024 * 1024 * 1024
    const simulatedFreeBytes = 10 * GB - 25_000

    const statsBefore = recService.getStorageStats(simulatedFreeBytes)
    expect(statsBefore.diskHealth).toBe('critical')
    expect(statsBefore.protectedBytes).toBe(20_000)
    expect(statsBefore.perCameraUsage).toHaveLength(1)
    expect(statsBefore.perCameraUsage[0].clipCount).toBe(3)

    const pruneRes = recService.enforceRetentionAndQuota(undefined, simulatedFreeBytes)
    expect(pruneRes.prunedCount).toBe(2) // both unprotected clips recycled to recover 25KB deficit
    expect(pruneRes.freedBytes).toBe(40_000)

    const remaining = recService.listRecordings()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(oldestStarred.id)
    expect(fs.existsSync(oldUnprotected.filePath)).toBe(false)
    expect(fs.existsSync(newestUnprotected.filePath)).toBe(false)

    // Warning health when between minFreeDiskGb (10) and lowDiskWarningGb (20)
    const statsWarn = recService.getStorageStats(15 * GB)
    expect(statsWarn.diskHealth).toBe('warning')

    // Healthy when above lowDiskWarningGb (20)
    const statsOk = recService.getStorageStats(50 * GB)
    expect(statsOk.diskHealth).toBe('healthy')
  })

  it('exports tamper-evident SHA-256 evidence bundle (.mp4 + .evidence.json)', async () => {
    const recDir = path.join(tmpDir, 'evidence-vault')
    const exportDir = path.join(tmpDir, 'exports')
    fs.mkdirSync(exportDir, { recursive: true })

    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => recDir)
    await streamService.startServer()
    const recService = new RecordingService(tmpDir, store, streamService)

    const target = recService.createNvrSegmentTarget('Front Porch')
    const rawBytes = Buffer.from('RINGWATCH-EVIDENCE-TEST-PAYLOAD-'.repeat(256))
    const srcPath = path.join(target.dir, `${target.prefix}_0001.mp4`)
    fs.writeFileSync(srcPath, rawBytes)

    const item = recService.registerRecordedSegment({
      cameraId: 'cam-1',
      cameraName: 'Front Porch',
      filePath: srcPath,
      createdAt: new Date().toISOString(),
      durationSeconds: 60,
      trigger: 'package',
    })!

    const destMp4 = path.join(exportDir, 'porch-delivery.mp4')
    const bundle = recService.exportEvidenceBundle(item.id, destMp4)

    expect(fs.existsSync(bundle.videoPath)).toBe(true)
    expect(fs.existsSync(bundle.manifestPath)).toBe(true)

    const expectedSha = crypto.createHash('sha256').update(rawBytes).digest('hex')
    expect(bundle.sha256).toBe(expectedSha)

    const manifest = JSON.parse(fs.readFileSync(bundle.manifestPath, 'utf-8')) as {
      schema: string
      sha256: string
      recording: {
        cameraName: string
        trigger: string
        sizeBytes: number
      }
    }
    expect(manifest.schema).toBe('ringwatch-evidence-bundle/v1')
    expect(manifest.sha256).toBe(expectedSha)
    expect(manifest.recording.cameraName).toBe('Front Porch')
    expect(manifest.recording.trigger).toBe('package')
    expect(manifest.recording.sizeBytes).toBe(rawBytes.length)
  })
})

describe('Windows System Theme & Live Stream Sync', () => {
  it('normalizes Windows 8-char RGBA accent hex and computes accessible dark/light variables', async () => {
    const { normalizeAccentHex, computeThemeCssVars } = await import('../src/utils/theme')

    expect(normalizeAccentHex('0078d4ff')).toBe('#0078d4')
    expect(normalizeAccentHex('#E74856FF')).toBe('#e74856')
    expect(normalizeAccentHex('not-a-hex')).toBeNull()
    expect(normalizeAccentHex(null)).toBeNull()

    const darkRed = computeThemeCssVars({
      shouldUseDarkColors: true,
      accentColor: 'e74856ff',
    })
    expect(darkRed.mode).toBe('dark')
    expect(darkRed.vars['--accent']).toBe('#e74856')
    expect(darkRed.vars['--accent-contrast']).toBe('#ffffff')

    // Bright yellow Windows accent automatically picks dark button text for readability
    const lightYellow = computeThemeCssVars({
      shouldUseDarkColors: false,
      accentColor: '#facc15ff',
    })
    expect(lightYellow.mode).toBe('light')
    expect(lightYellow.vars['--accent']).toBe('#facc15')
    expect(lightYellow.vars['--accent-contrast']).toBe('#0b0e13')
  })

  it('notifies listeners when live streams start and stop', () => {
    const tmpDir = makeTempDir()
    const streamService = new StreamService(() => tmpDir)
    const snapshots: number[] = []
    streamService.setOnStreamsChanged((sessions) => {
      snapshots.push(sessions.length)
    })

    streamService.startDemoStream('cam-1')
    streamService.startDemoStream('cam-2')
    streamService.stopStream('cam-1')
    streamService.stopAll()

    expect(snapshots).toEqual([1, 2, 1, 0])
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('Resilient Live-Stream Snapshot & AI Scan Fallback (cocoa_camera_v3)', () => {
  let tmpDir: string
  let streamService: StreamService

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    streamService?.stopAll()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('locates the newest finalized HLS .ts segment and ignores partial .tmp files', async () => {
    const recDir = path.join(tmpDir, 'hls-snap')
    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    await streamService.startServer()

    const prepared = await streamService.prepareNvrHlsOutput('cam-front-yard')
    const seg0 = path.join(prepared.dirPath, 'seg_00000.ts')
    const seg1 = path.join(prepared.dirPath, 'seg_00001.ts')
    const tmpSeg = path.join(prepared.dirPath, 'seg_00002.ts.tmp')

    fs.writeFileSync(seg0, Buffer.alloc(4096, 1))
    fs.writeFileSync(seg1, Buffer.alloc(4096, 2))
    fs.writeFileSync(tmpSeg, Buffer.alloc(4096, 3))
    fs.writeFileSync(
      prepared.playlistPath,
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg_00000.ts\n#EXTINF:2.0,\nseg_00001.ts\n',
    )
    streamService.registerNvrHlsFeed('cam-front-yard', prepared)

    expect(streamService.hasActiveFeed('cam-front-yard')).toBe(true)
    expect(streamService.getLatestHlsSegmentPath('cam-front-yard')).toBe(seg1)
  })

  it('extracts a valid live JPEG frame via FFmpeg and recovers when cocoa_camera_v3 getSnapshot times out after 15s', async () => {
    const recDir = path.join(tmpDir, 'vault')
    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    await streamService.startServer()
    const recService = new RecordingService(tmpDir, store, streamService)

    const sampleImg = path.resolve(__dirname, '..', 'public', 'demo', 'front_porch.jpg')
    const mp4Item = await recService.captureDemoRecording({
      cameraId: 'front-yard-id',
      cameraName: 'Front yard',
      durationSeconds: 4,
      trigger: 'continuous',
      sourceImagePath: sampleImg,
      thumbnailDataUrl: 'data:image/jpeg;base64,abc',
    })

    // Direct FFmpeg extraction from MP4 returns a valid JPEG SOI buffer
    const directJpeg = await recService.extractJpegFrame(mp4Item.filePath)
    expect(directJpeg).not.toBeNull()
    expect(directJpeg![0]).toBe(0xff)
    expect(directJpeg![1]).toBe(0xd8)

    const mockNotifications = {
      notifyPackageAlert: vi.fn(),
      notifyNvrAlert: vi.fn(),
    } as unknown as NotificationService
    const aiService = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: mockNotifications,
      onDetection: vi.fn(),
      onSecurityEvent: vi.fn(),
    })

    const ringService = new RingService({
      userDataDir: tmpDir,
      configStore: store,
      streamService,
      recordingService: recService,
      aiPackageService: aiService,
      notifications: mockNotifications,
      demoAssetsDir: path.resolve(__dirname, '..', 'public', 'demo'),
      callbacks: {
        onConnectionChanged: vi.fn(),
        onCamerasUpdated: vi.fn(),
        onSensorsUpdated: vi.fn(),
        onLocationsUpdated: vi.fn(),
        onSecurityEvent: vi.fn(),
        onRecordingsUpdated: vi.fn(),
        onStorageStatsUpdated: vi.fn(),
      },
    })

    // Simulate live mode with a cocoa_camera_v3 whose cloud getSnapshot() always rejects after 15s
    const failingGetSnapshot = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Snapshot for Front yard (cocoa_camera_v3 - Unknown Model) failed to refresh after 15 seconds',
        ),
      )

    const svcInternal = ringService as unknown as {
      connection: { mode: string }
      cameras: Array<{ id: string; name: string }>
      liveCamerasById: Map<string, unknown>
    }
    svcInternal.connection.mode = 'live'
    svcInternal.cameras = [{ id: 'front-yard-id', name: 'Front yard' }]
    svcInternal.liveCamerasById.set('front-yard-id', {
      id: 'front-yard-id',
      name: 'Front yard',
      getSnapshot: failingGetSnapshot,
    })

    // Case 1: Active HLS feed exists -> extracts live frame directly without waiting on failing cloud getSnapshot()
    const prepared = await streamService.prepareNvrHlsOutput('front-yard-id')
    const hlsSeg = path.join(prepared.dirPath, 'seg_00001.ts')
    fs.copyFileSync(mp4Item.filePath, hlsSeg)
    fs.writeFileSync(
      prepared.playlistPath,
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg_00001.ts\n',
    )
    streamService.registerNvrHlsFeed('front-yard-id', prepared)

    const fromHls = await ringService.captureSnapshotBase64('front-yard-id')
    expect(fromHls.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Buffer.from(fromHls.base64, 'base64')[0]).toBe(0xff)
    expect(failingGetSnapshot).not.toHaveBeenCalled()

    // Case 2: No active HLS feed -> getSnapshot() fails with cocoa_camera_v3 15s timeout -> falls back to recent local MP4
    streamService.unregisterNvrHlsFeed('front-yard-id')
    const fromRecentMp4 = await ringService.captureSnapshotBase64('front-yard-id')
    expect(failingGetSnapshot).toHaveBeenCalledTimes(1)
    expect(fromRecentMp4.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Buffer.from(fromRecentMp4.base64, 'base64')[0]).toBe(0xff)

    ringService.shutdown()
  })
})

describe('Always-Live Stream Continuity & Improved AI Box Detection', () => {
  let tmpDir: string
  let streamService: StreamService

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    streamService?.stopAll()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses isolated per-rotation HLS folders, waits for pending NVR feed, and auto-reattaches live viewers after rotation', async () => {
    const recDir = path.join(tmpDir, 'nvr-rot')
    const store = new ConfigStore(tmpDir, recDir)
    streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    await streamService.startServer()

    const emittedUrls: string[] = []
    streamService.setOnStreamsChanged((sessions) => {
      if (sessions[0]) emittedUrls.push(sessions[0].streamUrl)
    })

    // Rotation 1: NVR prepares output (pending), live viewer calls startRingHlsStream BEFORE registerNvrHlsFeed
    const rot1 = await streamService.prepareNvrHlsOutput('cam-porch')
    const mockStreamVideo = vi.fn()
    const viewerPromise = streamService.startRingHlsStream('cam-porch', {
      id: 'cam-porch',
      streamVideo: mockStreamVideo,
    })

    // Simulate NVR WebRTC connecting ~120ms later and writing first segment
    await new Promise((r) => setTimeout(r, 120))
    fs.writeFileSync(
      rot1.playlistPath,
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1.0,\nseg_00000.ts\n',
    )
    streamService.registerNvrHlsFeed('cam-porch', rot1)

    const sess1 = await viewerPromise
    expect(mockStreamVideo).not.toHaveBeenCalled()
    expect(sess1.streamUrl).toBe(rot1.streamUrl)
    expect(streamService.isStreaming('cam-porch')).toBe(true)

    // Rotation 2 (e.g. Ring 10-minute WebRTC rotation): old feed unregisters, new feed registers with unique dirPath
    streamService.unregisterNvrHlsFeed('cam-porch')
    const rot2 = await streamService.prepareNvrHlsOutput('cam-porch')
    expect(rot2.dirPath).not.toBe(rot1.dirPath)
    expect(rot2.streamUrl).not.toBe(rot1.streamUrl)

    fs.writeFileSync(
      rot2.playlistPath,
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1.0,\nseg_00000.ts\n',
    )
    streamService.registerNvrHlsFeed('cam-porch', rot2)

    // StreamService automatically re-attaches the live viewer to rot2 with zero manual clicks!
    await new Promise((r) => setTimeout(r, 250))
    expect(streamService.isStreaming('cam-porch')).toBe(true)
    expect(emittedUrls[emittedUrls.length - 1]).toBe(rot2.streamUrl)
  })

  it('recovers from Gemini HTTP 503 high-demand spikes via retry + temporary failover without overwriting saved model, and uses OpenAI detail=high', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    store.updateSettings({
      mode: 'live',
      packageAi: {
        enabled: true,
        provider: 'gemini',
        geminiModel: 'gemini-3.5-flash-lite',
        geminiApiKey: 'AIza-test-503',
        openaiApiKey: 'sk-test-high',
        minConfidence: 0.65,
      },
    })

    const mockNotifications = {
      notifyPackageAlert: vi.fn(),
    } as unknown as NotificationService
    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: mockNotifications,
      onDetection: vi.fn(),
      onSecurityEvent: vi.fn(),
      retryDelayMs: 0,
      motionFollowUpDelayMs: 50,
    })
    service.attachSnapshotSource({
      getCameraMeta: (id) => ({ id, name: 'Front yard' }),
      listCameraIds: () => ['front-yard'],
      captureSnapshotBase64: async () => ({
        base64: Buffer.from('fake-jpeg').toString('base64'),
        dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn',
      }),
    })

    // 1. Gemini 503 on gemini-3.5-flash-lite -> retries once, fails over temporarily to gemini-3-flash-preview
    const calledModels: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        calledModels.push(url)
        if (url.includes('gemini-3.5-flash-lite')) {
          return {
            ok: false,
            status: 503,
            text: async () =>
              JSON.stringify({
                error: {
                  code: 503,
                  message: 'This model is currently experiencing high demand.',
                  status: 'UNAVAILABLE',
                },
              }),
          }
        }
        return {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        sceneScan: 'Brown cardboard shipping box resting near the front steps',
                        packageDetected: true,
                        confidence: 0.89,
                        packageCount: 1,
                        carrierHint: null,
                        placement: 'Near front steps',
                        personPresent: false,
                        summary: 'Plain brown cardboard box detected near the front steps.',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        }
      }),
    )

    const geminiRes = await service.scanCamera('front-yard', 'manual')
    expect(geminiRes.rawError).toBeUndefined()
    expect(geminiRes.packageDetected).toBe(true)
    expect(geminiRes.model).toBe('gemini-3-flash-preview')
    // Temporary 503 failover must NOT permanently overwrite user's saved model
    expect(store.getPublicSettings().packageAi.geminiModel).toBe('gemini-3.5-flash-lite')
    expect(calledModels.filter((u) => u.includes('gemini-3.5-flash-lite'))).toHaveLength(2)

    // 2. OpenAI uses detail: 'high' and two-stage motion follow-up catches box placed seconds later
    store.updateSettings({
      packageAi: { provider: 'openai', openaiModel: 'gpt-4o-mini' },
    })

    let openAiCalls = 0
    const openAiFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      openAiCalls++
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ content: unknown }>
      }
      const userParts = body.messages[1].content as Array<{
        type: string
        image_url?: { detail?: string }
      }>
      const imgPart = userParts.find((p) => p.type === 'image_url')
      expect(imgPart?.image_url?.detail).toBe('high')

      const detected = openAiCalls >= 2
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  sceneScan: detected
                    ? 'Plain brown box now resting on porch'
                    : 'Delivery driver walking up driveway',
                  packageDetected: detected ? 'true' : 'false',
                  confidence: 0.91,
                  packageCount: detected ? 1 : 0,
                  carrierHint: null,
                  placement: detected ? 'Front porch' : null,
                  personPresent: !detected,
                  summary: detected
                    ? 'Cardboard box delivered on front porch.'
                    : 'Person walking up; no package placed yet.',
                }),
              },
            },
          ],
        }),
      }
    })
    vi.stubGlobal('fetch', openAiFetch)

    const initialMotion = await service.handleAutoTrigger('front-yard', 'motion')
    expect(initialMotion?.packageDetected).toBe(false)

    // Wait for automatic follow-up scan (50ms in test) to catch the newly placed box
    await new Promise((r) => setTimeout(r, 150))
    expect(openAiCalls).toBe(2)
    expect(service.listDetections()[0].packageDetected).toBe(true)

    service.stop()
  })
})

describe('Security Hardening', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('enforces per-session token auth, strict CORS, safe URI decoding, and HLS extension allowlist on StreamService', async () => {
    const streamService = new StreamService(() => tmpDir)
    const port = await streamService.startServer()

    try {
      const prepared = await streamService.prepareNvrHlsOutput('front-cam')
      fs.writeFileSync(prepared.playlistPath, '#EXTM3U\nseg_00001.ts\n', 'utf-8')
      fs.writeFileSync(path.join(prepared.dirPath, 'seg_00001.ts'), Buffer.alloc(2048, 0x47))
      fs.writeFileSync(path.join(prepared.dirPath, 'secret.txt'), 'not-hls', 'utf-8')

      // 1. Missing token -> 401
      const unauthRes = await fetch(`http://127.0.0.1:${port}/hls/${prepared.safeId}/index.m3u8`)
      expect(unauthRes.status).toBe(401)

      // 2. Wrong token -> 401
      const badTokenRes = await fetch(
        `http://127.0.0.1:${port}/media/000000000000000000000000000000000000000000000000/hls/${prepared.safeId}/index.m3u8`,
      )
      expect(badTokenRes.status).toBe(401)

      // 3. Malformed percent-encoding -> 400 (must not crash server)
      const badUriRes = await fetch(`http://127.0.0.1:${port}/media/%E0%A4%A/hls/x`)
      expect(badUriRes.status).toBe(400)

      // 4. Valid authenticated playlist + relative segment work cleanly
      const okPlaylist = await fetch(prepared.streamUrl, {
        headers: { Origin: 'null' },
      })
      expect(okPlaylist.status).toBe(200)
      expect(okPlaylist.headers.get('access-control-allow-origin')).toBe('null')
      expect(okPlaylist.headers.get('x-content-type-options')).toBe('nosniff')

      const relativeSegUrl = new URL('seg_00001.ts', prepared.streamUrl).toString()
      const okSeg = await fetch(relativeSegUrl)
      expect(okSeg.status).toBe(200)

      // 5. Untrusted external web origin never gets CORS access
      const evilOriginRes = await fetch(prepared.streamUrl, {
        headers: { Origin: 'https://evil.example' },
      })
      expect(evilOriginRes.headers.get('access-control-allow-origin')).toBeNull()

      // 6. Non-HLS file extension in HLS folder is blocked (403)
      const nonHlsUrl = new URL('secret.txt', prepared.streamUrl).toString()
      const blockedExtRes = await fetch(nonHlsUrl)
      expect(blockedExtRes.status).toBe(403)

      // 7. DNS rebinding Host header is rejected with 403
      const http = await import('node:http')
      const rebindStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: new URL(prepared.streamUrl).pathname,
            headers: { Host: `attacker.example:${port}` },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(rebindStatus).toBe(403)
    } finally {
      streamService.stopAll()
    }
  })

  it('auto-migrates legacy plaintext secrets to encrypted storage on load when DPAPI is available', () => {
    const configPath = path.join(tmpDir, 'ringwatch-config.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: 2,
        mode: 'live',
        secretsPlain: {
          ringRefreshToken: 'plain_token_abc',
          geminiApiKey: 'AIza-plain-key',
        },
      }),
      'utf-8',
    )

    const mockDpapi: SecretCryptoAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: (v) => Buffer.from(`dpapi:${v}`, 'utf-8'),
      decryptString: (b) => b.toString('utf-8').replace(/^dpapi:/, ''),
    }

    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'), mockDpapi)
    expect(store.getRingRefreshToken()).toBe('plain_token_abc')
    expect(store.getGeminiApiKey()).toBe('AIza-plain-key')

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    expect(onDisk.secretsPlain).toBeUndefined()
    expect(onDisk.secretsEncrypted).toBeDefined()
    expect(JSON.stringify(onDisk)).not.toContain('plain_token_abc')
    expect(JSON.stringify(onDisk)).not.toContain('AIza-plain-key')
  })

  it('refuses to download Ring cloud recordings over non-HTTPS URLs', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    const streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    const recordingService = new RecordingService(tmpDir, store, streamService)

    await expect(
      recordingService.downloadCloudRecording({
        cameraId: 'cam-1',
        cameraName: 'Front',
        dingId: '12345',
        durationSeconds: 30,
        camera: {
          recordToFile: async () => {},
          getSnapshot: async () => Buffer.alloc(0),
          getRecordingUrl: async () => 'http://127.0.0.1:8080/internal-secret',
        },
      }),
    ).rejects.toThrow(/non-HTTPS/i)
  })
})

describe('Enhanced Delivery Detection (Baseline Diff, Ground Crop, Motion-End & Smart Cooldown)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sends BEFORE baseline + AFTER current + zoomed delivery crop to Gemini, retries on 400 mediaResolution, and notifies on new deliveries', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    store.updateSettings({
      mode: 'live',
      packageAi: {
        enabled: true,
        provider: 'gemini',
        geminiModel: 'gemini-3-flash-preview',
        geminiApiKey: 'AIza-test-delivery',
        cooldownMinutes: 10,
      },
    })

    const notifySpy = vi.fn()
    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: { notifyPackageAlert: notifySpy } as unknown as NotificationService,
      onDetection: vi.fn(),
      onSecurityEvent: vi.fn(),
      retryDelayMs: 0,
      motionFollowUpDelaysMs: [],
      motionEndDelayMs: 40,
    })

    let frameSeq = 0
    const frames = [
      Buffer.from('empty-porch-frame').toString('base64'),
      Buffer.from('porch-with-1-box').toString('base64'),
      Buffer.from('porch-with-2-boxes').toString('base64'),
    ]
    service.attachSnapshotSource({
      getCameraMeta: (id) => ({ id, name: 'Front Porch' }),
      listCameraIds: () => ['cam-porch'],
      captureSnapshotBase64: async () => {
        const b64 = frames[Math.min(frameSeq++, frames.length - 1)]
        return { base64: b64, dataUrl: `data:image/jpeg;base64,${b64}` }
      },
      cropDeliveryZoneBase64: async (b64) => `crop_${b64}`,
    })

    let fetchCount = 0
    let secondScanImageCount = 0
    let sawMediaResolutionHigh = false
    let retriedWithoutMediaResolution = false

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        fetchCount++
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          contents?: Array<{ parts?: Array<{ text?: string; inline_data?: { data: string } }> }>
          generationConfig?: { mediaResolution?: string }
        }
        const inlineImages =
          body.contents?.[0]?.parts?.filter((p) => Boolean(p.inline_data)) ?? []

        // Scan 1: empty porch -> saves clean baseline (2 images: current + zoom crop)
        if (fetchCount === 1) {
          expect(inlineImages.length).toBe(2)
          expect(body.generationConfig?.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH')
          sawMediaResolutionHigh = true
          return {
            ok: true,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          sceneScan: 'Empty welcome mat and steps',
                          newObjectsFromBaseline: 'No baseline provided',
                          packageDetected: false,
                          confidence: 0.95,
                          packageCount: 0,
                          carrierHint: null,
                          placement: null,
                          personPresent: false,
                          summary: 'Empty porch.',
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
          }
        }

        // Scan 2 (attempt 1): simulate HTTP 400 rejecting mediaResolution -> service must strip & retry!
        if (fetchCount === 2) {
          secondScanImageCount = inlineImages.length
          return {
            ok: false,
            status: 400,
            text: async () => 'Invalid JSON payload received. Unknown name "mediaResolution"',
          }
        }

        // Scan 2 (retry without mediaResolution): 1st box detected with 0.56 confidence (now passes 0.50 default!)
        if (fetchCount === 3) {
          expect(body.generationConfig?.mediaResolution).toBeUndefined()
          retriedWithoutMediaResolution = true
          return {
            ok: true,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          sceneScan: 'Small brown box near front step',
                          newObjectsFromBaseline: 'New brown cardboard box appeared on porch step',
                          packageDetected: true,
                          confidence: 0.56,
                          packageCount: 1,
                          carrierHint: 'Amazon',
                          placement: 'Front step',
                          personPresent: false,
                          summary: 'New Amazon cardboard box left on the front step.',
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
          }
        }

        // Scan 3 (within 10m cooldown): a 2nd package arrives -> must bypass cooldown & alert!
        return {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        sceneScan: 'Two boxes now on front step',
                        newObjectsFromBaseline: 'Second white mailer added beside brown box',
                        packageDetected: true,
                        confidence: 0.88,
                        packageCount: 2,
                        carrierHint: 'USPS',
                        placement: 'Front step',
                        personPresent: false,
                        summary: 'Two packages now on the front step.',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        }
      }),
    )

    // 1. Clean baseline capture
    const clean = await service.scanCamera('cam-porch', 'motion')
    expect(clean.packageDetected).toBe(false)
    expect(sawMediaResolutionHigh).toBe(true)

    // 2. Motion ends -> unobstructed verification scan sends 3 images (baseline + current + zoom crop)
    service.handleMotionEnded('cam-porch')
    await new Promise((r) => setTimeout(r, 120))
    expect(secondScanImageCount).toBe(3)
    expect(retriedWithoutMediaResolution).toBe(true)
    expect(notifySpy).toHaveBeenCalledTimes(1)

    // 3. Second delivery arrives during cooldown (packageCount increases 1 -> 2) -> bypasses cooldown!
    const secondDelivery = await service.scanCamera('cam-porch', 'motion')
    expect(secondDelivery.packageDetected).toBe(true)
    expect(secondDelivery.notified).toBe(true)
    expect(notifySpy).toHaveBeenCalledTimes(2)

    service.stop()
  })

  it('crops the lower 68% delivery zone from a real JPEG via FFmpeg', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    const streamService = new StreamService(() => store.getPublicSettings().recordingsDir)
    const recordingService = new RecordingService(tmpDir, store, streamService)

    const sampleJpg = path.resolve(process.cwd(), 'public', 'demo', 'front_porch.jpg')
    const rawBuf = fs.readFileSync(sampleJpg)
    const cropped = await recordingService.createDeliveryZoneCrop(rawBuf)
    expect(cropped).not.toBeNull()
    expect(cropped![0]).toBe(0xff)
    expect(cropped![1]).toBe(0xd8)
    expect(cropped!.length).toBeGreaterThan(1024)
  })

  it('safely handles Windows ENOTEMPTY/EBUSY errors during HLS temp folder cleanup without throwing', async () => {
    const streamService = new StreamService(() => tmpDir)
    const prepared = await streamService.prepareNvrHlsOutput('cam-lock')
    streamService.registerNvrHlsFeed('cam-lock', prepared)

    // Simulate Windows NTFS lock throwing ENOTEMPTY on rmSync
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      const err = new Error('ENOTEMPTY, Directory not empty') as NodeJS.ErrnoException
      err.code = 'ENOTEMPTY'
      throw err
    })

    expect(() => streamService.unregisterNvrHlsFeed('cam-lock')).not.toThrow()
    expect(() => streamService.stopAll()).not.toThrow()
    rmSpy.mockRestore()
    fs.rmSync(prepared.dirPath, { recursive: true, force: true })
  })

  it('strips bloated base64 thumbnails from continuous NVR segments and avoids per-call fs.existsSync scans in listRecordings', () => {
    const recDir = path.join(tmpDir, 'perf-vault')
    fs.mkdirSync(recDir, { recursive: true })
    const segPath = path.join(recDir, 'front_continuous_2026-01-01_0001.mp4')
    fs.writeFileSync(segPath, Buffer.alloc(8192, 0x00))

    // Seed a legacy bloated index containing a 100KB base64 thumbnail on a continuous clip
    const bloatedThumb = `data:image/jpeg;base64,${'A'.repeat(100_000)}`
    fs.writeFileSync(
      path.join(tmpDir, 'recordings-index.json'),
      JSON.stringify([
        {
          id: 'legacy-seg-1',
          cameraId: 'cam-1',
          cameraName: 'Front',
          filePath: segPath,
          fileName: path.basename(segPath),
          createdAt: new Date().toISOString(),
          durationSeconds: 120,
          sizeBytes: 8192,
          trigger: 'continuous',
          starred: false,
          thumbnailDataUrl: bloatedThumb,
        },
      ]),
      'utf-8',
    )

    const store = new ConfigStore(tmpDir, recDir)
    const streamService = new StreamService(() => recDir)
    const recService = new RecordingService(tmpDir, store, streamService)

    const existsSpy = vi.spyOn(fs, 'existsSync')
    const listed = recService.listRecordings()
    expect(listed).toHaveLength(1)
    expect(listed[0].thumbnailDataUrl).toBeUndefined()
    // listRecordings() must NOT hammer disk with fs.existsSync on every call
    expect(existsSpy).not.toHaveBeenCalled()
    existsSpy.mockRestore()

    recService.flushIndexSync()
    const savedRaw = fs.readFileSync(path.join(tmpDir, 'recordings-index.json'), 'utf-8')
    expect(savedRaw.length).toBeLessThan(1000)
  })

  it('detects localized porch scene changes while ignoring uniform sunlight/cloud shifts and blank frames', () => {
    const base = Buffer.alloc(MOTION_GRID_PIXELS, 110)

    // 1. Uniform brightness shift (+35 across whole frame = passing cloud / exposure change) -> NOT significant
    const sunlit = Buffer.alloc(MOTION_GRID_PIXELS, 145)
    expect(computeLumaSceneChange(base, sunlit).significant).toBe(false)

    // 2. Minor H.264 compression jitter (+/- 4) -> NOT significant
    const jitter = Buffer.from(base)
    for (let i = 0; i < jitter.length; i++) {
      jitter[i] = i % 2 === 0 ? 114 : 106
    }
    expect(computeLumaSceneChange(base, jitter).significant).toBe(false)

    // 3. Blank/black reconnect frame -> NOT significant
    const black = Buffer.alloc(MOTION_GRID_PIXELS, 0)
    expect(computeLumaSceneChange(base, black).significant).toBe(false)

    // 4. Localized cardboard box (~5% of lower porch zone, +60 contrast) -> SIGNIFICANT
    const withBox = Buffer.from(base)
    const lowerStart = Math.floor(MOTION_GRID_PIXELS * 0.65)
    for (let i = lowerStart; i < lowerStart + 100; i++) {
      withBox[i] = 170
    }
    const diff = computeLumaSceneChange(base, withBox)
    expect(diff.significant).toBe(true)
    expect(diff.lowerChangedRatio).toBeGreaterThan(0.03)
  })

  it('keeps motion follow-ups active after a transient initial error and queues overlapping triggers instead of dropping them', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    store.updateSettings({
      mode: 'live',
      packageAi: {
        enabled: true,
        provider: 'openai',
        openaiModel: 'gpt-4o-mini',
        openaiApiKey: 'sk-test-resilience',
        triggerOnMotion: true,
        triggerOnDoorbell: true,
        cooldownMinutes: 5,
      },
    })

    const notifyMock = vi.fn()
    const fakeNotifications = {
      notifyPackageAlert: notifyMock,
    } as unknown as NotificationService

    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: fakeNotifications,
      onDetection: () => {},
      onSecurityEvent: () => {},
      retryDelayMs: 0,
      motionFollowUpDelaysMs: [40],
      motionEndDelayMs: 40,
    })

    let snapCall = 0
    const source: SnapshotSource = {
      getCameraMeta: (id) => (id === 'porch' ? { id, name: 'Porch' } : undefined),
      listCameraIds: () => ['porch'],
      captureSnapshotBase64: async () => {
        snapCall++
        if (snapCall === 1) {
          throw new Error('Snapshot timed out while camera woke up')
        }
        return {
          base64: Buffer.from(`frame-${snapCall}`).toString('base64'),
          dataUrl: `data:image/jpeg;base64,${Buffer.from(`frame-${snapCall}`).toString('base64')}`,
        }
      },
    }
    service.attachSnapshotSource(source)

    let visionCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        visionCalls++
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    packageDetected: visionCalls >= 1,
                    confidence: 0.92,
                    packageCount: 1,
                    carrierHint: 'UPS',
                    placement: 'Front porch',
                    personPresent: false,
                    summary: 'UPS box left on front porch.',
                  }),
                },
              },
            ],
          }),
        }
      }),
    )

    // Initial scan fails transiently on snapshot -> follow-up at 40ms MUST still run and detect package
    const first = await service.handleAutoTrigger('porch', 'motion')
    expect(first?.rawError).toContain('Snapshot timed out')
    await new Promise((r) => setTimeout(r, 120))
    expect(visionCalls).toBe(1)
    expect(service.listDetections()[0].packageDetected).toBe(true)

    // Overlapping doorbell press while a scan is in flight MUST be queued rather than dropped
    let releaseSlowScan!: () => void
    let slowScanStarted!: () => void
    const slowStartedPromise = new Promise<void>((r) => {
      slowScanStarted = r
    })
    let overlapCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        overlapCalls++
        if (overlapCalls === 1) {
          slowScanStarted()
          await new Promise<void>((r) => {
            releaseSlowScan = r
          })
        }
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    packageDetected: overlapCalls >= 2,
                    confidence: 0.95,
                    packageCount: overlapCalls >= 2 ? 2 : 0,
                    carrierHint: 'Amazon',
                    placement: 'Steps',
                    personPresent: false,
                    summary:
                      overlapCalls >= 2
                        ? 'Two Amazon boxes on steps.'
                        : 'Clear.',
                  }),
                },
              },
            ],
          }),
        }
      }),
    )

    const slowPromise = service.handleAutoTrigger('porch', 'motion')
    await slowStartedPromise
    // Doorbell arrives while motion scan is still waiting on API
    const queued = await service.handleAutoTrigger('porch', 'doorbell')
    expect(queued).toBeNull()
    releaseSlowScan()
    await slowPromise

    await new Promise((r) => setTimeout(r, 150))
    expect(overlapCalls).toBeGreaterThanOrEqual(2)
    expect(service.listDetections()[0].packageCount).toBe(2)

    service.stop()
  })
})






