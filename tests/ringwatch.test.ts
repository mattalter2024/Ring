import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type tls from 'node:tls'
import { ConfigStore, type SecretCryptoAdapter } from '../server/services/configStore'
import {
  AiPackageService,
  parseVisionResponse,
  type SnapshotSource,
} from '../server/services/aiPackageService'
import { StreamService } from '../server/services/streamService'
import {
  computeLumaSceneChange,
  MOTION_GRID_PIXELS,
  RecordingService,
} from '../server/services/recordingService'
import { RingService } from '../server/services/ringService'
import type { NotificationService } from '../server/services/notificationService'
import {
  FileKeyCryptoAdapter,
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} from '../server/services/secretCrypto'
import {
  TlsCertService,
  generateSelfSignedX509Cert,
  validateTlsCertAndKey,
} from '../server/services/tlsCertService'
import { RingWatchServer } from '../server/httpServer'

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
        minScanIntervalSeconds: 0,
        pauseWhilePackagePresent: false,
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

    // 2. OpenAI High Accuracy mode uses detail: 'high' and follow-up catches box placed seconds later
    store.updateSettings({
      packageAi: {
        provider: 'openai',
        openaiModel: 'gpt-4o-mini',
        scanQualityMode: 'high',
        minScanIntervalSeconds: 0,
        pauseWhilePackagePresent: false,
      },
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
        scanQualityMode: 'high',
        minScanIntervalSeconds: 0,
        pauseWhilePackagePresent: false,
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
        minScanIntervalSeconds: 0,
        pauseWhilePackagePresent: false,
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

describe('Standalone Web + Backend Server (REST, Mounted Media & Optional Login Gate)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Ignore transient Windows NTFS file handle locks in temp test dir
    }
  })

  it('encrypts secrets with FileKeyCryptoAdapter (AES-256-GCM) and verifies scrypt passwords & HMAC sessions', () => {
    const cryptoAdapter = new FileKeyCryptoAdapter(tmpDir)
    expect(cryptoAdapter.isEncryptionAvailable()).toBe(true)

    const encrypted = cryptoAdapter.encryptString('super-secret-ring-token')
    expect(encrypted.toString('utf-8')).not.toContain('super-secret-ring-token')
    expect(cryptoAdapter.decryptString(encrypted)).toBe('super-secret-ring-token')

    // Persisted keyfile reloads cleanly across restarts
    const reloadedAdapter = new FileKeyCryptoAdapter(tmpDir)
    expect(reloadedAdapter.decryptString(encrypted)).toBe('super-secret-ring-token')

    const hash = hashPassword('my-nvr-pass')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('my-nvr-pass', hash)).toBe(true)
    expect(verifyPassword('wrong-pass', hash)).toBe(false)

    const signingKey = cryptoAdapter.getSessionSigningKey()
    const token = createSessionToken(signingKey, 60_000)
    expect(verifySessionToken(token, signingKey)).toBe(true)
    expect(verifySessionToken(`${token}tampered`, signingKey)).toBe(false)
  })

  it('serves REST bootstrap, mounted relative /media URLs, and enforces the optional login gate end-to-end', async () => {
    const recDir = path.join(tmpDir, 'recordings')
    const webDir = path.join(tmpDir, 'web-dist')
    fs.mkdirSync(webDir, { recursive: true })
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><html><body>RingWatch Web</body></html>', 'utf-8')

    // Disable continuous auto-start so the test doesn't spawn background demo FFmpeg loops
    const preStore = new ConfigStore(tmpDir, recDir)
    preStore.updateSettings({ continuousAutoStart: false })

    const server = new RingWatchServer({
      dataDir: tmpDir,
      defaultRecordingsDir: recDir,
      webDistDir: webDir,
      demoAssetsDir: path.resolve(process.cwd(), 'public', 'demo'),
      host: '127.0.0.1',
      port: 0,
    })

    const { port } = await server.start()
    const base = `http://127.0.0.1:${port}`

    try {
      // 1. Static web frontend serves index.html
      const htmlRes = await fetch(`${base}/`)
      expect(htmlRes.status).toBe(200)
      expect(await htmlRes.text()).toContain('RingWatch Web')

      // 2. Open mode by default (no password set) -> authEnabled: false, /api/bootstrap allowed
      const authStatusRes = await fetch(`${base}/api/auth/status`)
      expect(authStatusRes.status).toBe(200)
      expect(await authStatusRes.json()).toMatchObject({
        authEnabled: false,
        authenticated: true,
        managedByEnv: false,
        hasUsers: false,
        currentUser: null,
      })

      const bootRes = await fetch(`${base}/api/bootstrap`)
      expect(bootRes.status).toBe(200)
      const boot = (await bootRes.json()) as {
        connection: { mode: string }
        settings: { mode: string }
      }
      expect(boot.connection.mode).toBe('demo')

      // 3. Mounted StreamService generates same-origin relative /media/<token>/... URLs
      fs.mkdirSync(recDir, { recursive: true })
      const fakeMp4 = path.join(recDir, 'front_clip_test.mp4')
      fs.writeFileSync(fakeMp4, Buffer.alloc(4096, 0x22))
      const relUrl = server.streamService.getRecordingPlaybackUrl('front_clip_test.mp4')
      expect(relUrl.startsWith('/media/')).toBe(true)

      const mediaRes = await fetch(`${base}${relUrl}`, {
        headers: { Range: 'bytes=0-1023' },
      })
      expect(mediaRes.status).toBe(206)
      expect(mediaRes.headers.get('content-range')).toBe('bytes 0-1023/4096')
      await mediaRes.arrayBuffer()

      // 4. Enable optional login gate via /api/auth/password
      const setPassRes = await fetch(`${base}/api/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: 'nvr-secret-2026' }),
      })
      expect(setPassRes.status).toBe(200)
      expect(await setPassRes.json()).toEqual({ ok: true, authEnabled: true })

      // 5. Unauthenticated requests are now blocked with 401
      const unauthBoot = await fetch(`${base}/api/bootstrap`)
      expect(unauthBoot.status).toBe(401)
      await unauthBoot.text()
      const unauthMedia = await fetch(`${base}${relUrl}`)
      expect(unauthMedia.status).toBe(401)
      await unauthMedia.text()

      // 6. Wrong password rejected with 401
      const badLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      })
      expect(badLogin.status).toBe(401)
      await badLogin.text()

      // 7. Correct password sets HttpOnly session cookie that unlocks /api/bootstrap & /media
      const goodLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'nvr-secret-2026' }),
      })
      expect(goodLogin.status).toBe(200)
      await goodLogin.text()
      const setCookie = goodLogin.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('ringwatch_session=')
      expect(setCookie).toContain('HttpOnly')
      const cookieHeader = setCookie.split(';')[0]

      const authedBoot = await fetch(`${base}/api/bootstrap`, {
        headers: { Cookie: cookieHeader },
      })
      expect(authedBoot.status).toBe(200)
      await authedBoot.text()

      const authedMedia = await fetch(`${base}${relUrl}`, {
        headers: { Cookie: cookieHeader },
      })
      expect(authedMedia.status).toBe(200)
      await authedMedia.arrayBuffer()

      // 8. Disabling password returns to open mode
      const disableRes = await fetch(`${base}/api/auth/password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          currentPassword: 'nvr-secret-2026',
          newPassword: '',
        }),
      })
      expect(disableRes.status).toBe(200)
      expect(await disableRes.json()).toEqual({ ok: true, authEnabled: false })
      const openAgain = await fetch(`${base}/api/bootstrap`)
      expect(openAgain.status).toBe(200)
      await openAgain.text()
    } finally {
      await server.stop()
    }
  })

  it('redacts secrets in troubleshooting logs, serves /api/logs/download, and guards /api/internal/shutdown with control token', async () => {
    const recDir = path.join(tmpDir, 'recordings')
    const webDir = path.join(tmpDir, 'web-dist')
    fs.mkdirSync(webDir, { recursive: true })
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>RingWatch</html>', 'utf-8')

    const preStore = new ConfigStore(tmpDir, recDir)
    preStore.updateSettings({ continuousAutoStart: false })

    let shutdownCalled = false
    const server = new RingWatchServer({
      dataDir: tmpDir,
      defaultRecordingsDir: recDir,
      webDistDir: webDir,
      demoAssetsDir: path.resolve(process.cwd(), 'public', 'demo'),
      host: '127.0.0.1',
      port: 0,
      controlToken: 'svc-secret-control-token-123',
      onRequestShutdown: () => {
        shutdownCalled = true
      },
    })

    const { port } = await server.start()
    const base = `http://127.0.0.1:${port}`

    try {
      server.logger.info('Connected with sk-proj-supersecretkey1234567890 and Bearer abcdef123456')

      const logsRes = await fetch(`${base}/api/logs`)
      expect(logsRes.status).toBe(200)
      const logsJson = (await logsRes.json()) as { lines: string[]; logsDir: string }
      const joined = logsJson.lines.join('\n')
      expect(joined).toContain('[REDACTED_OPENAI_KEY]')
      expect(joined).toContain('Bearer [REDACTED]')
      expect(joined).not.toContain('sk-proj-supersecretkey1234567890')

      const dlRes = await fetch(`${base}/api/logs/download`)
      expect(dlRes.status).toBe(200)
      expect(dlRes.headers.get('content-disposition')).toContain('ringwatch-troubleshooting-')
      const reportText = await dlRes.text()
      expect(reportText).toContain('SYSTEM & NVR DIAGNOSTICS')
      expect(reportText).toContain('[REDACTED_OPENAI_KEY]')

      // Missing or wrong control token must be rejected with 403
      const badShut = await fetch(`${base}/api/internal/shutdown`, {
        method: 'POST',
        headers: { 'X-RingWatch-Control': 'wrong-token' },
      })
      expect(badShut.status).toBe(403)
      await badShut.text()
      expect(shutdownCalled).toBe(false)

      // Valid control token triggers graceful shutdown callback
      const okShut = await fetch(`${base}/api/internal/shutdown`, {
        method: 'POST',
        headers: { 'X-RingWatch-Control': 'svc-secret-control-token-123' },
      })
      expect(okShut.status).toBe(200)
      await okShut.text()
      await new Promise((r) => setTimeout(r, 120))
      expect(shutdownCalled).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('detects Windows and macOS clients accurately and adapts native frontend labels', async () => {
    const { detectClientPlatform, getPlatformLabels } = await import(
      '../src/utils/platform'
    )

    const macPlatform = detectClientPlatform({
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15',
    })
    expect(macPlatform).toBe('mac')
    const macLabels = getPlatformLabels(macPlatform)
    expect(macLabels.isMac).toBe(true)
    expect(macLabels.fileManagerName).toBe('Finder')
    expect(macLabels.shortcutModifier).toBe('⌘')
    expect(macLabels.timelineControlsHint).toContain('Pinch')

    const winPlatform = detectClientPlatform({
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    })
    expect(winPlatform).toBe('windows')
    const winLabels = getPlatformLabels(winPlatform)
    expect(winLabels.isMac).toBe(false)
    expect(winLabels.fileManagerName).toBe('Explorer')
    expect(winLabels.shortcutModifier).toBe('Ctrl')
  })

  it('enforces multi-user accounts, RBAC roles/custom permissions, live session revocation, and WebAuthn Passkey challenges', async () => {
    const recDir = path.join(tmpDir, 'recordings')
    const webDir = path.join(tmpDir, 'web-dist')
    fs.mkdirSync(webDir, { recursive: true })
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>RingWatch</html>', 'utf-8')

    const preStore = new ConfigStore(tmpDir, recDir)
    preStore.updateSettings({ continuousAutoStart: false })

    const server = new RingWatchServer({
      dataDir: tmpDir,
      defaultRecordingsDir: recDir,
      webDistDir: webDir,
      demoAssetsDir: path.resolve(process.cwd(), 'public', 'demo'),
      host: '127.0.0.1',
      port: 0,
    })

    const { port } = await server.start()
    const base = `http://127.0.0.1:${port}`

    try {
      // Seed a fake MP4 to test media RBAC
      fs.mkdirSync(recDir, { recursive: true })
      fs.writeFileSync(path.join(recDir, 'rbac_clip.mp4'), Buffer.alloc(2048, 0x33))
      const mediaUrl = server.streamService.getRecordingPlaybackUrl('rbac_clip.mp4')

      // 1. First user created must be Admin and automatically sets an authenticated session cookie
      const badFirst = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'viewer1',
          displayName: 'Viewer',
          role: 'viewer',
          password: 'password123',
        }),
      })
      expect(badFirst.status).toBe(400)
      await badFirst.text()

      const adminCreate = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'matt',
          displayName: 'Matt Admin',
          role: 'admin',
          password: 'admin-password',
        }),
      })
      expect(adminCreate.status).toBe(201)
      const adminUser = (await adminCreate.json()) as { id: string; role: string }
      expect(adminUser.role).toBe('admin')
      const adminCookie = (adminCreate.headers.get('set-cookie') ?? '').split(';')[0]
      expect(adminCookie).toContain('ringwatch_session=')

      // 2. Unauthenticated requests are now blocked (401)
      const unauth = await fetch(`${base}/api/bootstrap`)
      expect(unauth.status).toBe(401)
      await unauth.text()

      // 3. Admin creates a Guest (live-only) and a Custom-permission user
      const guestCreate = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'guest1',
          displayName: 'House Guest',
          role: 'guest',
          password: 'guest-password',
        }),
      })
      expect(guestCreate.status).toBe(201)
      const guestUser = (await guestCreate.json()) as { id: string; permissions: string[] }
      expect(guestUser.permissions).toEqual(['cameras:view', 'ai:view'])

      const customCreate = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'deliverybot',
          displayName: 'Delivery Monitor',
          role: 'custom',
          customPermissions: ['cameras:view', 'ai:view', 'ai:manage'],
          password: 'custom-password',
        }),
      })
      expect(customCreate.status).toBe(201)
      await customCreate.text()

      // 4. Cannot demote or delete the last active Admin
      const demoteAdmin = await fetch(`${base}/api/users/${adminUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'viewer' }),
      })
      expect(demoteAdmin.status).toBe(400)
      await demoteAdmin.text()

      // 5. Sign in as Guest and verify strict RBAC enforcement
      const guestLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'guest1', password: 'guest-password' }),
      })
      expect(guestLogin.status).toBe(200)
      await guestLogin.text()
      const guestCookie = (guestLogin.headers.get('set-cookie') ?? '').split(';')[0]

      // Guest can load bootstrap, but recordings & sensors are scrubbed empty
      const guestBoot = await fetch(`${base}/api/bootstrap`, {
        headers: { Cookie: guestCookie },
      })
      expect(guestBoot.status).toBe(200)
      const guestBootJson = (await guestBoot.json()) as {
        recordings: unknown[]
        sensors: unknown[]
      }
      expect(guestBootJson.recordings).toEqual([])
      expect(guestBootJson.sensors).toEqual([])

      // Guest is blocked (403) from recordings, recording media, NVR, alarm, settings, logs, and users
      expect((await fetch(`${base}/api/recordings`, { headers: { Cookie: guestCookie } })).status).toBe(403)
      expect((await fetch(`${base}${mediaUrl}`, { headers: { Cookie: guestCookie } })).status).toBe(403)
      expect((await fetch(`${base}/api/users`, { headers: { Cookie: guestCookie } })).status).toBe(403)
      expect((await fetch(`${base}/api/logs`, { headers: { Cookie: guestCookie } })).status).toBe(403)
      expect(
        (
          await fetch(`${base}/api/nvr/stop`, {
            method: 'POST',
            headers: { Cookie: guestCookie },
          })
        ).status,
      ).toBe(403)

      // 6. Custom user can trigger AI test alert (ai:manage) but is blocked (403) from recordings & users
      const customLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'deliverybot', password: 'custom-password' }),
      })
      expect(customLogin.status).toBe(200)
      await customLogin.text()
      const customCookie = (customLogin.headers.get('set-cookie') ?? '').split(';')[0]

      const customAiOk = await fetch(`${base}/api/ai/test-alert`, {
        method: 'POST',
        headers: { Cookie: customCookie },
      })
      expect(customAiOk.status).toBe(200)
      await customAiOk.text()
      expect((await fetch(`${base}/api/recordings`, { headers: { Cookie: customCookie } })).status).toBe(403)

      // 7. Admin disabling Guest immediately invalidates Guest's live session cookie (401)
      const disableGuest = await fetch(`${base}/api/users/${guestUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ disabled: true }),
      })
      expect(disableGuest.status).toBe(200)
      await disableGuest.text()

      const guestRevoked = await fetch(`${base}/api/bootstrap`, {
        headers: { Cookie: guestCookie },
      })
      expect(guestRevoked.status).toBe(401)
      await guestRevoked.text()

      // 8. WebAuthn Passkey registration options generate discoverable credentials for 1Password/Bitwarden/Touch ID/Windows Hello
      const regOptsRes = await fetch(`${base}/api/auth/passkey/register-options`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
          Origin: `http://localhost:${port}`,
        },
        body: JSON.stringify({ authenticatorType: 'any' }),
      })
      expect(regOptsRes.status).toBe(200)
      const regOpts = (await regOptsRes.json()) as {
        challengeId: string
        options: {
          challenge: string
          rp: { id: string }
          user: { name: string }
          authenticatorSelection?: {
            residentKey?: string
            requireResidentKey?: boolean
            authenticatorAttachment?: string
          }
        }
      }
      expect(regOpts.challengeId).toBeTruthy()
      expect(regOpts.options.challenge).toBeTruthy()
      expect(regOpts.options.rp.id).toBe('localhost')
      expect(regOpts.options.user.name).toBe('matt')
      expect(regOpts.options.authenticatorSelection?.residentKey).toBe('required')
      expect(regOpts.options.authenticatorSelection?.requireResidentKey).toBe(true)
      expect(regOpts.options.authenticatorSelection?.authenticatorAttachment).toBeUndefined()

      // Platform-specific mode (Mac Touch ID / Windows Hello) sets authenticatorAttachment: 'platform'
      const platformOptsRes = await fetch(`${base}/api/auth/passkey/register-options`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
          Origin: `http://localhost:${port}`,
        },
        body: JSON.stringify({ authenticatorType: 'platform' }),
      })
      expect(platformOptsRes.status).toBe(200)
      const platformOpts = (await platformOptsRes.json()) as {
        options: { authenticatorSelection?: { authenticatorAttachment?: string } }
      }
      expect(platformOpts.options.authenticatorSelection?.authenticatorAttachment).toBe('platform')

      // Raw IP address origin (127.0.0.1) is rejected cleanly with actionable guidance
      const ipOptsRes = await fetch(`${base}/api/auth/passkey/register-options`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({}),
      })
      expect(ipOptsRes.status).toBe(400)
      const ipErr = (await ipOptsRes.json()) as { error: string }
      expect(ipErr.error).toContain('localhost')

      const badRegVerify = await fetch(`${base}/api/auth/passkey/register-verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          challengeId: regOpts.challengeId,
          name: 'Fake Key',
          response: { id: 'bad', rawId: 'bad', type: 'public-key', response: {} },
        }),
      })
      expect(badRegVerify.status).toBe(400)
      await badRegVerify.text()
    } finally {
      await server.stop()
    }
  })
})

describe('Vault Actions, Demo Video Cleanup & Clear All Videos', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('auto-purges demo videos in Live Mode and skips demo files during rescanDirectory', () => {
    const store = new ConfigStore(tmpDir)
    const recDir = path.join(tmpDir, 'recordings')
    fs.mkdirSync(recDir, { recursive: true })
    store.updateSettings({ recordingsDir: recDir, mode: 'demo' })

    const streamService = new StreamService(() => recDir)
    const recService = new RecordingService(tmpDir, store, streamService)

    const demoFile = path.join(recDir, 'front-porch-doorbell-pro_package_2026-01-01_10-00-00.mp4')
    const realFile = path.join(recDir, 'garage-cam_motion_2026-01-01_10-05-00.mp4')
    fs.writeFileSync(demoFile, Buffer.alloc(4096, 0x11))
    fs.writeFileSync(realFile, Buffer.alloc(4096, 0x22))

    // In Demo Mode, both are indexed
    const demoScan = recService.rescanDirectory()
    expect(demoScan.recordings.length).toBe(2)

    // Switch to Live Mode -> listRecordings hides demo clips immediately
    store.updateSettings({ mode: 'live' })
    const liveListed = recService.listRecordings()
    expect(liveListed.length).toBe(1)
    expect(liveListed[0].fileName).toBe(path.basename(realFile))

    // purgeDemoRecordings removes demo MP4 from disk and index while preserving real recordings
    const purged = recService.purgeDemoRecordings()
    expect(purged.deletedCount).toBe(1)
    expect(fs.existsSync(demoFile)).toBe(false)
    expect(fs.existsSync(realFile)).toBe(true)

    // Even if a leftover demo MP4 reappears on disk in Live Mode, rescanDirectory skips it
    const strayDemo = path.join(recDir, 'driveway-floodlight-cam_motion_2026-01-01_11-00-00.mp4')
    fs.writeFileSync(strayDemo, Buffer.alloc(4096, 0x33))
    const liveScan = recService.rescanDirectory()
    expect(liveScan.recordings.length).toBe(1)
    expect(liveScan.recordings[0].fileName).toBe(path.basename(realFile))
  })

  it('supports Clear All Videos (preserving or deleting starred clips), binary MP4 import, Evidence Bundle export, and folder path APIs with RBAC', async () => {
    const recDir = path.join(tmpDir, 'recordings')
    const webDir = path.join(tmpDir, 'web')
    fs.mkdirSync(webDir, { recursive: true })
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>ok</html>')

    const preStore = new ConfigStore(tmpDir, recDir)
    preStore.updateSettings({ continuousAutoStart: false })

    const server = new RingWatchServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tmpDir,
      defaultRecordingsDir: recDir,
      webDistDir: webDir,
      demoAssetsDir: path.join(tmpDir, 'no-demo-assets'),
    })

    const { port } = await server.start()
    const base = `http://127.0.0.1:${port}`

    try {
      // Create Admin + Viewer users to verify RBAC on vault endpoints
      const createAdmin = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          displayName: 'Admin',
          role: 'admin',
          password: 'admin-password',
        }),
      })
      expect(createAdmin.status).toBe(201)
      await createAdmin.text()
      const adminCookie = (createAdmin.headers.get('set-cookie') ?? '').split(';')[0]

      const createViewer = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'viewer',
          displayName: 'Viewer',
          role: 'viewer',
          password: 'viewer-password',
        }),
      })
      expect(createViewer.status).toBe(201)
      await createViewer.text()

      const viewerLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: 'viewer-password' }),
      })
      expect(viewerLogin.status).toBe(200)
      await viewerLogin.text()
      const viewerCookie = (viewerLogin.headers.get('set-cookie') ?? '').split(';')[0]

      // 1. Viewer cannot import or clear all videos (403)
      const viewerImport = await fetch(`${base}/api/recordings/import`, {
        method: 'POST',
        headers: {
          Cookie: viewerCookie,
          'Content-Type': 'video/mp4',
          'X-Filename': 'test.mp4',
        },
        body: Buffer.alloc(4096, 0x41),
      })
      expect(viewerImport.status).toBe(403)
      await viewerImport.text()

      const viewerClear = await fetch(`${base}/api/recordings`, {
        method: 'DELETE',
        headers: { Cookie: viewerCookie },
      })
      expect(viewerClear.status).toBe(403)
      await viewerClear.text()

      // 2. Admin imports two MP4 files via POST /api/recordings/import
      const upload1 = await fetch(`${base}/api/recordings/import`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'video/mp4',
          'X-Filename': encodeURIComponent('porch clip 1.mp4'),
        },
        body: Buffer.alloc(4096, 0x55),
      })
      expect(upload1.status).toBe(201)
      const clip1 = (await upload1.json()) as { id: string; filePath: string; fileName: string }
      expect(fs.existsSync(clip1.filePath)).toBe(true)

      const upload2 = await fetch(`${base}/api/recordings/import`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'video/mp4',
          'X-Filename': 'porch_clip_2.mp4',
        },
        body: Buffer.alloc(4096, 0x66),
      })
      expect(upload2.status).toBe(201)
      const clip2 = (await upload2.json()) as { id: string; filePath: string }

      // Star clip1
      const starRes = await fetch(`${base}/api/recordings/${clip1.id}/star`, {
        method: 'POST',
        headers: { Cookie: adminCookie },
      })
      expect(starRes.status).toBe(200)
      await starRes.text()

      // 3. Evidence Bundle export writes valid MP4 + SHA-256 .evidence.json manifest (no EISDIR!)
      const evRes = await fetch(`${base}/api/recordings/${clip1.id}/evidence`, {
        method: 'POST',
        headers: { Cookie: adminCookie },
      })
      expect(evRes.status).toBe(200)
      const bundle = (await evRes.json()) as {
        videoPath: string
        manifestPath: string
        sha256: string
      }
      expect(fs.existsSync(bundle.videoPath)).toBe(true)
      expect(fs.existsSync(bundle.manifestPath)).toBe(true)
      expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/)

      // 4. Open Folder endpoints return exact path for clipboard/toast feedback
      const rootFolderRes = await fetch(`${base}/api/recordings/open-folder`, {
        method: 'POST',
        headers: { Cookie: viewerCookie },
      })
      expect(rootFolderRes.status).toBe(200)
      const rootFolderJson = (await rootFolderRes.json()) as { ok: boolean; path: string }
      expect(rootFolderJson.ok).toBe(true)
      expect(rootFolderJson.path).toBeTruthy()

      const clipFolderRes = await fetch(`${base}/api/recordings/${clip1.id}/open-folder`, {
        method: 'POST',
        headers: { Cookie: viewerCookie },
      })
      expect(clipFolderRes.status).toBe(200)
      const clipFolderJson = (await clipFolderRes.json()) as {
        ok: boolean
        path: string
        dir: string
      }
      expect(clipFolderJson.ok).toBe(true)
      expect(clipFolderJson.path).toBe(clip1.filePath)
      expect(clipFolderJson.dir).toBe(path.dirname(clip1.filePath))

      // 5. DELETE /api/recordings?includeStarred=0 keeps starred clip1 and deletes unstarred clip2
      const clearUnstarred = await fetch(`${base}/api/recordings?includeStarred=0`, {
        method: 'DELETE',
        headers: { Cookie: adminCookie },
      })
      expect(clearUnstarred.status).toBe(200)
      const clearUnstarredJson = (await clearUnstarred.json()) as {
        deletedCount: number
        remainingCount: number
      }
      expect(clearUnstarredJson.deletedCount).toBe(1)
      expect(clearUnstarredJson.remainingCount).toBe(1)
      expect(fs.existsSync(clip1.filePath)).toBe(true)
      expect(fs.existsSync(clip2.filePath)).toBe(false)

      // 6. DELETE /api/recordings (default includeStarred=1) wipes ALL videos including starred clips
      const clearAll = await fetch(`${base}/api/recordings`, {
        method: 'DELETE',
        headers: { Cookie: adminCookie },
      })
      expect(clearAll.status).toBe(200)
      const clearAllJson = (await clearAll.json()) as {
        deletedCount: number
        remainingCount: number
        stats: { totalClips: number }
      }
      expect(clearAllJson.deletedCount).toBe(1)
      expect(clearAllJson.remainingCount).toBe(0)
      expect(clearAllJson.stats.totalClips).toBe(0)
      expect(fs.existsSync(clip1.filePath)).toBe(false)
    } finally {
      await server.stop()
    }
  })
})

describe('AI Spend Reduction (Cost-Saver Pipeline #1–#6)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Ignore transient Windows NTFS file handle locks in temp test dir
    }
  })

  it('skips Cloud Vision at $0 when post-motion snapshot matches clean baseline luma grid (#1) and triggers when a box appears', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    store.updateSettings({
      mode: 'live',
      packageAi: {
        enabled: true,
        provider: 'openai',
        openaiModel: 'gpt-4.1-nano',
        openaiApiKey: 'sk-test-cost-saver',
        requirePersistentChange: true,
        minScanIntervalSeconds: 0,
        pauseWhilePackagePresent: false,
      },
    })

    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: { notifyPackageAlert: vi.fn() } as unknown as NotificationService,
      onDetection: vi.fn(),
      onSecurityEvent: vi.fn(),
      retryDelayMs: 0,
      motionFollowUpDelaysMs: [40],
      motionEndDelayMs: 40,
    })

    // Create 64x36 luma grids: baseline empty porch, unchanged frame, and frame with a cardboard box patch
    const emptyGrid = Buffer.alloc(64 * 36, 90)
    const unchangedGrid = Buffer.alloc(64 * 36, 92) // slight ambient brightness drift only
    const boxGrid = Buffer.from(emptyGrid)
    // Paint a localized 14x10 bright parcel on the lower porch
    for (let y = 20; y < 30; y++) {
      for (let x = 24; x < 38; x++) {
        boxGrid[y * 64 + x] = 215
      }
    }

    const gridsByB64 = new Map<string, Buffer>([
      [Buffer.from('frame-baseline').toString('base64'), emptyGrid],
      [Buffer.from('frame-unchanged').toString('base64'), unchangedGrid],
      [Buffer.from('frame-with-box').toString('base64'), boxGrid],
    ])
    const frameOrder = Array.from(gridsByB64.keys())
    let idx = 0

    service.attachSnapshotSource({
      getCameraMeta: (id) => ({ id, name: 'Front Porch' }),
      listCameraIds: () => ['cam-front'],
      captureSnapshotBase64: async () => {
        const base64 = frameOrder[Math.min(idx++, frameOrder.length - 1)]
        return { base64, dataUrl: `data:image/jpeg;base64,${base64}` }
      },
      extractLumaGridFromJpegBase64: async (b64) => gridsByB64.get(b64) ?? null,
    })

    let fetchCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        fetchCalls++
        const isBoxFrame = fetchCalls >= 2
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    packageDetected: isBoxFrame,
                    confidence: 0.94,
                    packageCount: isBoxFrame ? 1 : 0,
                    carrierHint: isBoxFrame ? 'Amazon' : null,
                    placement: isBoxFrame ? 'Doormat' : null,
                    personPresent: false,
                    uncertain: false,
                    summary: isBoxFrame ? 'Amazon box on doormat.' : 'Empty porch.',
                  }),
                },
              },
            ],
          }),
        }
      }),
    )

    // 1. First scan establishes clean baseline (calls Vision once)
    const first = await service.handleAutoTrigger('cam-front', 'motion')
    expect(first?.packageDetected).toBe(false)
    expect(first?.imagesSubmitted).toBe(1)
    expect(fetchCalls).toBe(1)

    // Cost-saver #2: Since personPresent=false and packageDetected=false, ZERO blind follow-ups run!
    await new Promise((r) => setTimeout(r, 100))
    expect(fetchCalls).toBe(1)

    // 2. Second motion event where scene matches empty baseline -> skipped locally at $0!
    const skipped = await service.handleAutoTrigger('cam-front', 'motion')
    expect(skipped?.imagesSubmitted).toBe(0)
    expect(skipped?.packageDetected).toBe(false)
    expect(fetchCalls).toBe(1) // ZERO new Cloud Vision API calls!
    expect(service.getUsageStats().skippedByLocalGateToday).toBe(1)

    // 3. Third motion event where a localized box actually remains -> passes local gate and calls Vision!
    const delivered = await service.handleAutoTrigger('cam-front', 'motion')
    expect(delivered?.packageDetected).toBe(true)
    expect(fetchCalls).toBe(2)
    expect(service.getUsageStats().scansToday).toBe(2)

    service.stop()
  })

  it('uses 1 low-res triage image in Balanced mode, escalates only when uncertain, and never escalates in Economy mode (#3)', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    store.updateSettings({
      mode: 'live',
      packageAi: {
        enabled: true,
        provider: 'openai',
        openaiModel: 'gpt-4o-mini',
        openaiApiKey: 'sk-test-balanced',
        scanQualityMode: 'balanced',
        minScanIntervalSeconds: 0,
        pauseWhilePackagePresent: false,
      },
    })

    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: { notifyPackageAlert: vi.fn() } as unknown as NotificationService,
      onDetection: vi.fn(),
      onSecurityEvent: vi.fn(),
      retryDelayMs: 0,
      motionFollowUpDelaysMs: [],
    })

    let snapSeq = 0
    service.attachSnapshotSource({
      getCameraMeta: (id) => ({ id, name: 'Porch' }),
      listCameraIds: () => ['cam-1'],
      captureSnapshotBase64: async () => {
        const b64 = Buffer.from(`snap-${++snapSeq}`).toString('base64')
        return { base64: b64, dataUrl: `data:image/jpeg;base64,${b64}` }
      },
      cropDeliveryZoneBase64: async () => Buffer.from('zoom-crop').toString('base64'),
    })

    const observedCalls: Array<{
      detailLevels: string[]
      imageCount: number
      maxTokens: number
    }> = []
    let callNum = 0

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        callNum++
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          max_tokens?: number
          messages: Array<{ content: unknown }>
        }
        const parts = body.messages[1].content as Array<{
          type: string
          image_url?: { detail?: string }
        }>
        const imgParts = parts.filter((p) => p.type === 'image_url')
        observedCalls.push({
          detailLevels: imgParts.map((p) => p.image_url?.detail ?? ''),
          imageCount: imgParts.length,
          maxTokens: body.max_tokens ?? 0,
        })

        // Call 1 (clear triage): returns clear, uncertain=false -> NO escalation
        // Call 2 (uncertain triage): returns uncertain=true -> triggers Stage 2 high-res verify (Call 3)
        // Call 3 (Stage 2 high-res verify): confirms package
        // Call 4 (Economy mode): returns uncertain=true -> MUST NOT escalate
        const payload =
          callNum === 1
            ? {
                packageDetected: false,
                confidence: 0.96,
                packageCount: 0,
                carrierHint: null,
                placement: null,
                personPresent: false,
                uncertain: false,
                summary: 'Porch empty.',
              }
            : callNum === 2 || callNum === 4
              ? {
                  packageDetected: false,
                  confidence: 0.55,
                  packageCount: 0,
                  carrierHint: null,
                  placement: null,
                  personPresent: false,
                  uncertain: true,
                  summary: 'Small shadowed object near steps.',
                }
              : {
                  packageDetected: true,
                  confidence: 0.92,
                  packageCount: 1,
                  carrierHint: 'USPS',
                  placement: 'Top step',
                  personPresent: false,
                  uncertain: false,
                  summary: 'Confirmed small padded USPS mailer on top step.',
                }

        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(payload) } }],
          }),
        }
      }),
    )

    // 1. Balanced clear scan: 1 low-res image only, max_tokens=220
    const clearRec = await service.scanCamera('cam-1', 'motion')
    expect(clearRec.packageDetected).toBe(false)
    expect(clearRec.imagesSubmitted).toBe(1)
    expect(observedCalls).toHaveLength(1)
    expect(observedCalls[0]).toEqual({
      detailLevels: ['low'],
      imageCount: 1,
      maxTokens: 220,
    })

    // 2. Balanced uncertain scan: Stage 1 (1 low-res) escalates to Stage 2 (3 high-res: baseline + current + crop)
    const verifiedRec = await service.scanCamera('cam-1', 'motion')
    expect(verifiedRec.packageDetected).toBe(true)
    expect(verifiedRec.carrierHint).toBe('USPS')
    expect(verifiedRec.imagesSubmitted).toBe(4)
    expect(observedCalls).toHaveLength(3)
    expect(observedCalls[1]).toEqual({ detailLevels: ['low'], imageCount: 1, maxTokens: 220 })
    expect(observedCalls[2]).toEqual({
      detailLevels: ['high', 'high', 'high'],
      imageCount: 3,
      maxTokens: 220,
    })

    // 3. Economy mode: even when uncertain=true, stays at 1 low-res image and NEVER escalates
    store.updateSettings({ packageAi: { scanQualityMode: 'economy' } })
    const econRec = await service.scanCamera('cam-1', 'motion')
    expect(econRec.imagesSubmitted).toBe(1)
    expect(observedCalls).toHaveLength(4)
    expect(observedCalls[3]).toEqual({ detailLevels: ['low'], imageCount: 1, maxTokens: 220 })

    service.stop()
  })

  it('enforces minScanIntervalSeconds, pauseWhilePackagePresent, dailyScanLimit, and activeHoursEnabled (#4)', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    store.updateSettings({
      mode: 'live',
      packageAi: {
        enabled: true,
        provider: 'openai',
        openaiApiKey: 'sk-test-caps',
        minScanIntervalSeconds: 90,
        pauseWhilePackagePresent: true,
        dailyScanLimit: 2,
        cooldownMinutes: 10,
        activeHoursEnabled: false,
      },
    })

    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: { notifyPackageAlert: vi.fn() } as unknown as NotificationService,
      onDetection: vi.fn(),
      onSecurityEvent: vi.fn(),
      retryDelayMs: 0,
      motionFollowUpDelaysMs: [],
    })

    service.attachSnapshotSource({
      getCameraMeta: (id) => ({ id, name: 'Porch' }),
      listCameraIds: () => ['cam-front'],
      captureSnapshotBase64: async () => ({
        base64: Buffer.from('frame').toString('base64'),
        dataUrl: 'data:image/jpeg;base64,ZnJhbWU=',
      }),
    })

    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        calls++
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    packageDetected: calls === 2,
                    confidence: 0.93,
                    packageCount: calls === 2 ? 1 : 0,
                    carrierHint: null,
                    placement: null,
                    personPresent: false,
                    uncertain: false,
                    summary: calls === 2 ? 'Box on porch.' : 'Empty porch.',
                  }),
                },
              },
            ],
          }),
        }
      }),
    )

    // 1. First motion scan succeeds (scansToday = 1)
    expect(await service.handleAutoTrigger('cam-front', 'motion')).not.toBeNull()
    expect(calls).toBe(1)

    // 2. Immediate repeat motion is throttled by minScanIntervalSeconds=90
    expect(await service.handleAutoTrigger('cam-front', 'motion')).toBeNull()
    expect(service.getUsageStats().skippedByThrottleToday).toBe(1)
    expect(calls).toBe(1)

    // 3. Doorbell ring bypasses motion throttle and detects a package (scansToday = 2, hitting dailyScanLimit=2)
    const doorbellRec = await service.handleAutoTrigger('cam-front', 'doorbell')
    expect(doorbellRec?.packageDetected).toBe(true)
    expect(calls).toBe(2)

    // 4. Further auto triggers hit dailyScanLimit=2 and are blocked
    expect(await service.handleAutoTrigger('cam-front', 'doorbell')).toBeNull()
    expect(service.getUsageStats().skippedByDailyLimitToday).toBe(1)
    expect(calls).toBe(2)

    // 5. Pause-while-present blocks repeat motion when daily limit is raised
    store.updateSettings({ packageAi: { dailyScanLimit: 60 } })
    expect(await service.handleAutoTrigger('cam-front', 'motion')).toBeNull()
    expect(service.getUsageStats().skippedByAlreadyPresentToday).toBe(1)
    expect(calls).toBe(2)

    // 6. Manual scan ALWAYS bypasses daily cap and pause-while-present
    store.updateSettings({ packageAi: { dailyScanLimit: 2 } })
    const manualRec = await service.scanCamera('cam-front', 'manual')
    expect(manualRec.rawError).toBeUndefined()
    expect(calls).toBe(3)

    // 7. Active delivery hours window (normal + overnight wrap-around)
    store.updateSettings({
      packageAi: { activeHoursEnabled: true, activeHoursStart: 6, activeHoursEnd: 22 },
    })
    expect(service.isWithinActiveHours(new Date('2026-11-20T03:30:00'))).toBe(false)
    expect(service.isWithinActiveHours(new Date('2026-11-20T14:00:00'))).toBe(true)
    expect(service.isWithinActiveHours(new Date('2026-11-20T22:00:00'))).toBe(false)

    store.updateSettings({
      packageAi: { activeHoursEnabled: true, activeHoursStart: 22, activeHoursEnd: 6 },
    })
    expect(service.isWithinActiveHours(new Date('2026-11-20T23:15:00'))).toBe(true)
    expect(service.isWithinActiveHours(new Date('2026-11-20T02:00:00'))).toBe(true)
    expect(service.isWithinActiveHours(new Date('2026-11-20T12:00:00'))).toBe(false)

    service.stop()
  })

  it('sends Gemini MEDIA_RESOLUTION_LOW + thinkingBudget=0 in Balanced mode and strips thinkingConfig on HTTP 400 (#5)', async () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    store.updateSettings({
      mode: 'live',
      packageAi: {
        enabled: true,
        provider: 'gemini',
        geminiModel: 'gemini-3-flash-preview',
        geminiApiKey: 'AIza-test-thinking',
        scanQualityMode: 'balanced',
      },
    })

    const service = new AiPackageService({
      userDataDir: tmpDir,
      configStore: store,
      notifications: { notifyPackageAlert: vi.fn() } as unknown as NotificationService,
      onDetection: vi.fn(),
      onSecurityEvent: vi.fn(),
      retryDelayMs: 0,
      motionFollowUpDelaysMs: [],
    })

    service.attachSnapshotSource({
      getCameraMeta: (id) => ({ id, name: 'Porch' }),
      listCameraIds: () => ['cam-1'],
      captureSnapshotBase64: async () => ({
        base64: Buffer.from('img').toString('base64'),
        dataUrl: 'data:image/jpeg;base64,aW1n',
      }),
    })

    let attempt = 0
    let sawThinkingZero = false
    let sawLowRes = false
    let retriedWithoutThinking = false

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        attempt++
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          generationConfig?: {
            mediaResolution?: string
            maxOutputTokens?: number
            thinkingConfig?: { thinkingBudget?: number }
          }
        }
        expect(body.generationConfig?.maxOutputTokens).toBe(220)
        if (attempt === 1) {
          sawLowRes = body.generationConfig?.mediaResolution === 'MEDIA_RESOLUTION_LOW'
          sawThinkingZero = body.generationConfig?.thinkingConfig?.thinkingBudget === 0
          return {
            ok: false,
            status: 400,
            text: async () => 'Invalid JSON payload: unknown field "thinkingConfig"',
          }
        }
        retriedWithoutThinking = body.generationConfig?.thinkingConfig === undefined
        return {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        packageDetected: false,
                        confidence: 0.95,
                        packageCount: 0,
                        carrierHint: null,
                        placement: null,
                        personPresent: false,
                        uncertain: false,
                        summary: 'No package present.',
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

    const rec = await service.scanCamera('cam-1', 'manual')
    expect(rec.rawError).toBeUndefined()
    expect(sawLowRes).toBe(true)
    expect(sawThinkingZero).toBe(true)
    expect(retriedWithoutThinking).toBe(true)
    expect(attempt).toBe(2)

    service.stop()
  })

  it('serves live AiUsageStats on GET /api/ai/usage and GET /api/bootstrap (#4 & #6)', async () => {
    const recDir = path.join(tmpDir, 'videos')
    const webDir = path.join(tmpDir, 'web')
    fs.mkdirSync(webDir, { recursive: true })
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>ok</html>')

    const preStore = new ConfigStore(tmpDir, recDir)
    preStore.updateSettings({ continuousAutoStart: false })

    const server = new RingWatchServer({
      dataDir: tmpDir,
      defaultRecordingsDir: recDir,
      demoAssetsDir: path.resolve(process.cwd(), 'public', 'demo'),
      webDistDir: webDir,
      host: '127.0.0.1',
      port: 0,
    })

    const { port } = await server.start()
    const base = `http://127.0.0.1:${port}`
    try {
      server.aiPackageService.recordLocalSkip('local-gate')
      server.aiPackageService.recordLocalSkip('throttle')

      const usageRes = await fetch(`${base}/api/ai/usage`)
      expect(usageRes.status).toBe(200)
      const usage = (await usageRes.json()) as {
        scansToday: number
        skippedByLocalGateToday: number
        skippedByThrottleToday: number
        dailyScanLimit: number
      }
      expect(usage.skippedByLocalGateToday).toBe(1)
      expect(usage.skippedByThrottleToday).toBe(1)
      expect(usage.dailyScanLimit).toBe(60)

      const bootRes = await fetch(`${base}/api/bootstrap`)
      expect(bootRes.status).toBe(200)
      const boot = (await bootRes.json()) as {
        aiUsageStats?: { skippedByLocalGateToday: number; dailyScanLimit: number }
      }
      expect(boot.aiUsageStats?.skippedByLocalGateToday).toBe(1)
      expect(boot.aiUsageStats?.dailyScanLimit).toBe(60)
    } finally {
      await server.stop()
    }
  })
})

describe('HTTPS & TLS Certificates (Auto-Renewing Self-Signed & Custom Certs)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Ignore transient Windows NTFS file handle locks in temp test dir
    }
  })

  function httpsGetJson(port: number, urlPath: string): Promise<{
    statusCode: number
    body: string
    peerFingerprint256: string
    peerSubject: string
  }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'GET',
          rejectUnauthorized: false,
          agent: false,
        },
        (res) => {
          const sock = res.socket as tls.TLSSocket
          const peer = sock.getPeerCertificate()
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
              peerFingerprint256: peer.fingerprint256 ?? '',
              peerSubject: peer.subject?.CN ?? '',
            })
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  it('generates valid RFC 5280 X.509 v3 self-signed certs with SANs and auto-renews when expiring or when SANs change', () => {
    const store = new ConfigStore(tmpDir, path.join(tmpDir, 'videos'))
    const reloadSpy = vi.fn()
    const tlsSvc = new TlsCertService({
      dataDir: tmpDir,
      configStore: store,
      onMaterialUpdated: reloadSpy,
    })

    // 1. Initial self-signed generation
    const initial = tlsSvc.ensureCertificate({ notifyOnReload: false })
    const x509 = new crypto.X509Certificate(initial.material.cert)
    expect(x509.verify(x509.publicKey)).toBe(true)
    expect(x509.subjectAltName).toContain('DNS:localhost')
    expect(x509.subjectAltName).toContain('IP Address:127.0.0.1')
    const initialFp = x509.fingerprint256

    // Subsequent check with healthy cert does NOT regenerate
    const second = tlsSvc.ensureCertificate({ notifyOnReload: true })
    expect(second.reloaded).toBe(false)
    expect(reloadSpy).not.toHaveBeenCalled()

    // 2. Simulate an expiring self-signed cert (only 5 days remaining < 30-day threshold)
    const expiring = generateSelfSignedX509Cert({
      commonName: 'localhost',
      dnsNames: ['localhost'],
      ipAddresses: ['127.0.0.1', '::1'],
      validityDays: 5,
    })
    fs.writeFileSync(path.join(tmpDir, 'certs', 'self-signed-cert.pem'), expiring.certPem)
    fs.writeFileSync(path.join(tmpDir, 'certs', 'self-signed-key.pem'), expiring.keyPem)

    const renewed = tlsSvc.ensureCertificate({ notifyOnReload: true })
    expect(renewed.reloaded).toBe(true)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    const renewedX509 = new crypto.X509Certificate(renewed.material.cert)
    expect(renewedX509.fingerprint256).not.toBe(initialFp)
    const daysLeft = Math.floor(
      (new Date(renewedX509.validTo).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    )
    expect(daysLeft).toBeGreaterThan(350)

    // 3. Adding a custom hostname SAN triggers automatic renewal with the new SAN
    store.updateSettings({ tls: { customHostnames: ['ringwatch.home.arpa'] } })
    const sanRenewed = tlsSvc.ensureCertificate({ notifyOnReload: true })
    expect(sanRenewed.reloaded).toBe(true)
    const sanX509 = new crypto.X509Certificate(sanRenewed.material.cert)
    expect(sanX509.subjectAltName).toContain('DNS:ringwatch.home.arpa')

    // 4. Rejects mismatched key/cert pairs and expired certificates cleanly
    const other = generateSelfSignedX509Cert({
      commonName: 'other.local',
      dnsNames: ['other.local'],
      ipAddresses: ['127.0.0.1'],
    })
    expect(() => validateTlsCertAndKey(sanRenewed.material.cert, other.keyPem)).toThrow(
      /validation failed/i,
    )

    const expired = generateSelfSignedX509Cert({
      commonName: 'expired.local',
      dnsNames: ['expired.local'],
      ipAddresses: ['127.0.0.1'],
      validityDays: 1,
      notBefore: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    })
    expect(() => validateTlsCertAndKey(expired.certPem, expired.keyPem)).toThrow(/expired/i)
  })

  it('serves live HTTPS, hot-reloads uploaded custom PEM and external cert files without restart, downloads public .crt, and redirects HTTP->HTTPS', async () => {
    const recDir = path.join(tmpDir, 'videos')
    const webDir = path.join(tmpDir, 'web')
    fs.mkdirSync(webDir, { recursive: true })
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>RingWatch HTTPS</html>')

    const preStore = new ConfigStore(tmpDir, recDir)
    preStore.updateSettings({ continuousAutoStart: false })

    const server = new RingWatchServer({
      dataDir: tmpDir,
      defaultRecordingsDir: recDir,
      demoAssetsDir: path.resolve(process.cwd(), 'public', 'demo'),
      webDistDir: webDir,
      host: '127.0.0.1',
      port: 0,
      httpsPort: 0,
    })

    const bound = await server.start()
    expect(bound.httpsPort).toBeGreaterThan(0)
    const httpBase = `http://127.0.0.1:${bound.port}`
    const httpsPort = bound.httpsPort!

    try {
      // 1. Live HTTPS handshake works immediately with auto-generated self-signed cert
      const initialHttps = await httpsGetJson(httpsPort, '/api/health')
      expect(initialHttps.statusCode).toBe(200)
      const health = JSON.parse(initialHttps.body) as {
        ok: boolean
        httpsActive: boolean
        httpsPort: number
      }
      expect(health.ok).toBe(true)
      expect(health.httpsActive).toBe(true)
      expect(health.httpsPort).toBe(httpsPort)
      const selfSignedFp = initialHttps.peerFingerprint256
      expect(selfSignedFp.length).toBeGreaterThan(20)

      // 2. Public certificate download returns ONLY public PEM (never private key)
      const dlRes = await fetch(`${httpBase}/api/tls/certificate/download`)
      expect(dlRes.status).toBe(200)
      const dlText = await dlRes.text()
      expect(dlText).toContain('-----BEGIN CERTIFICATE-----')
      expect(dlText).not.toContain('PRIVATE KEY')

      // 3. Upload custom PEM certificate -> live HTTPS server hot-reloads with ZERO restart!
      const customA = generateSelfSignedX509Cert({
        commonName: 'custom-pem.ringwatch.local',
        dnsNames: ['custom-pem.ringwatch.local', 'localhost'],
        ipAddresses: ['127.0.0.1'],
        validityDays: 180,
      })
      const customAFp = new crypto.X509Certificate(customA.certPem).fingerprint256
      const uploadRes = await fetch(`${httpBase}/api/tls/custom-pem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certPem: customA.certPem, keyPem: customA.keyPem }),
      })
      expect(uploadRes.status).toBe(200)
      const uploadStatus = (await uploadRes.json()) as {
        certSource: string
        fingerprint256: string
      }
      expect(uploadStatus.certSource).toBe('uploaded-pem')
      expect(uploadStatus.fingerprint256).toBe(customAFp)

      const afterUploadHttps = await httpsGetJson(httpsPort, '/api/health')
      expect(afterUploadHttps.peerFingerprint256).toBe(customAFp)
      expect(afterUploadHttps.peerSubject).toBe('custom-pem.ringwatch.local')

      // 4. External cert files on disk (Certbot / win-acme workflow) + live auto-reload on file update
      const extDir = path.join(tmpDir, 'external-acme')
      fs.mkdirSync(extDir, { recursive: true })
      const extCertPath = path.join(extDir, 'fullchain.pem')
      const extKeyPath = path.join(extDir, 'privkey.pem')

      const acmeV1 = generateSelfSignedX509Cert({
        commonName: 'acme-v1.example.test',
        dnsNames: ['acme-v1.example.test', 'localhost'],
        ipAddresses: ['127.0.0.1'],
        validityDays: 90,
      })
      fs.writeFileSync(extCertPath, acmeV1.certPem)
      fs.writeFileSync(extKeyPath, acmeV1.keyPem)

      const filesRes = await fetch(`${httpBase}/api/tls/custom-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certPath: extCertPath, keyPath: extKeyPath }),
      })
      expect(filesRes.status).toBe(200)
      const acmeV1Fp = new crypto.X509Certificate(acmeV1.certPem).fingerprint256
      expect((await httpsGetJson(httpsPort, '/api/health')).peerFingerprint256).toBe(acmeV1Fp)

      // Simulate Certbot/win-acme renewing files on disk -> ensureCertificate auto-hot-reloads!
      const acmeV2 = generateSelfSignedX509Cert({
        commonName: 'acme-v2.example.test',
        dnsNames: ['acme-v2.example.test', 'localhost'],
        ipAddresses: ['127.0.0.1'],
        validityDays: 90,
      })
      fs.writeFileSync(extCertPath, acmeV2.certPem)
      fs.writeFileSync(extKeyPath, acmeV2.keyPem)
      const reloadRes = server.tlsCertService.ensureCertificate({ notifyOnReload: true })
      expect(reloadRes.reloaded).toBe(true)
      const acmeV2Fp = new crypto.X509Certificate(acmeV2.certPem).fingerprint256
      expect((await httpsGetJson(httpsPort, '/api/health')).peerFingerprint256).toBe(acmeV2Fp)

      // 5. Switch back to auto-renewing self-signed cert
      const backRes = await fetch(`${httpBase}/api/tls/use-self-signed`, { method: 'POST' })
      expect(backRes.status).toBe(200)
      expect((await httpsGetJson(httpsPort, '/api/health')).peerFingerprint256).toBe(selfSignedFp)

      // 6. Optional HTTP -> HTTPS redirect (exempting /api/health for Windows Service & Tray)
      const patchRes = await fetch(`${httpBase}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tls: { redirectHttpToHttps: true } }),
      })
      expect(patchRes.status).toBe(200)

      const redirectRes = await fetch(`${httpBase}/`, { redirect: 'manual' })
      expect(redirectRes.status).toBe(308)
      expect(redirectRes.headers.get('location')).toBe(`https://127.0.0.1:${httpsPort}/`)

      // /api/health MUST remain 200 on HTTP so Windows Tray & Service health checks never break
      const healthHttp = await fetch(`${httpBase}/api/health`, { redirect: 'manual' })
      expect(healthHttp.status).toBe(200)
    } finally {
      await server.stop()
    }
  })
})








