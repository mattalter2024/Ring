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



