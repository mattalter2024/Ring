import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { Loader2, Volume2, VolumeX } from 'lucide-react'
import type { LiveStreamSession, RingCameraInfo } from '@shared/types'

interface LiveVideoPlayerProps {
  camera: RingCameraInfo
  session?: LiveStreamSession
  isConnecting?: boolean
}

export function LiveVideoPlayer({
  camera,
  session,
  isConnecting = false,
}: LiveVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [muted, setMuted] = useState(true)
  const [buffering, setBuffering] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)

  // Real Ring HLS stream via hls.js with automatic reconnection on session rotation
  useEffect(() => {
    if (!session || session.mode !== 'hls') {
      setStreamError(null)
      setBuffering(false)
      return
    }
    const video = videoRef.current
    if (!video) return

    setStreamError(null)
    setBuffering(true)
    let hls: Hls | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    const attachHls = () => {
      if (disposed) return
      if (hls) {
        hls.destroy()
        hls = null
      }

      if (Hls.isSupported()) {
        let recoveryAttempts = 0
        hls = new Hls({
          lowLatencyMode: false,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 5,
          enableWorker: false,
        })
        hls.loadSource(session.streamUrl)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          recoveryAttempts = 0
          setStreamError(null)
          setBuffering(false)
          void video.play().catch(() => {})
        })
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          setStreamError(null)
          setBuffering(false)
        })
        hls.on(Hls.Events.ERROR, (_ev, data) => {
          if (!data.fatal || !hls || disposed) return
          if (recoveryAttempts < 3) {
            recoveryAttempts += 1
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad()
              return
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError()
              return
            }
          }
          setStreamError('Reconnecting live stream…')
          if (!retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = null
              attachHls()
            }, 3000)
          }
        })
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = session.streamUrl
        void video.play().then(() => setBuffering(false)).catch(() => {})
      }
    }

    attachHls()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      if (hls) {
        hls.destroy()
      }
    }
  }, [session?.streamUrl, session?.mode, session?.startedAt])

  // Animated 30fps Demo Mode live feed canvas backed by realistic generated camera still
  useEffect(() => {
    if (!session || session.mode !== 'demo') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = new Image()
    img.src = camera.lastSnapshotDataUrl || `./demo/${camera.demoImage || 'front_porch.jpg'}`
    let rafId = 0
    const startTime = performance.now()

    const draw = (now: number) => {
      const elapsed = (now - startTime) / 1000
      const w = canvas.width
      const h = canvas.height

      ctx.fillStyle = '#070a0f'
      ctx.fillRect(0, 0, w, h)

      if (img.complete && img.naturalWidth > 0) {
        // Subtle live camera micro-pan / breathing luminance for realistic feed feel
        const scale = 1.02 + Math.sin(elapsed * 0.45) * 0.005
        const dw = w * scale
        const dh = h * scale
        const dx = (w - dw) / 2 + Math.sin(elapsed * 0.35) * 3
        const dy = (h - dh) / 2 + Math.cos(elapsed * 0.25) * 2
        ctx.drawImage(img, dx, dy, dw, dh)
      }

      // Crisp bottom-left camera telemetry bar (standard CCTV timestamp)
      const stamp = new Date().toLocaleString([], {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })

      ctx.fillStyle = 'rgba(7, 10, 15, 0.72)'
      ctx.fillRect(14, h - 42, 336, 28)
      ctx.fillStyle = '#e2e8f0'
      ctx.font = '600 13px "JetBrains Mono", Consolas, monospace'
      ctx.fillText(`${camera.name.toUpperCase()}  ${stamp}`, 24, h - 23)

      // Subtle bitrate telemetry bottom-right
      const kbps = Math.round(1820 + Math.sin(elapsed * 2.1) * 95)
      ctx.fillStyle = 'rgba(7, 10, 15, 0.72)'
      ctx.fillRect(w - 156, h - 42, 142, 28)
      ctx.fillStyle = '#4ade80'
      ctx.fillText(`1080p · ${kbps} kbps`, w - 146, h - 23)

      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [session, camera.lastSnapshotDataUrl, camera.demoImage, camera.name])

  if (session?.mode === 'hls') {
    return (
      <>
        <video
          ref={videoRef}
          muted={muted}
          playsInline
          autoPlay
          controls={false}
          poster={camera.lastSnapshotDataUrl}
          onPlaying={() => {
            setBuffering(false)
            setStreamError(null)
          }}
        />
        <div
          style={{
            position: 'absolute',
            right: 10,
            bottom: 10,
            display: 'flex',
            gap: 6,
          }}
        >
          <button
            type="button"
            className="btn btn-sm"
            style={{ background: 'rgba(9,13,19,0.78)', color: '#edf2f7', borderColor: 'rgba(255,255,255,0.16)' }}
            onClick={() => setMuted((m) => !m)}
            title={muted ? 'Unmute live audio' : 'Mute live audio'}
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
        </div>
        {(buffering || streamError) && (
          <div className="viewport-connecting-badge">
            <Loader2 size={13} className="spin" />
            <span>{streamError ?? 'Buffering live video…'}</span>
          </div>
        )}
      </>
    )
  }

  if (session?.mode === 'demo') {
    return <canvas ref={canvasRef} width={1280} height={720} />
  }

  return (
    <>
      {camera.lastSnapshotDataUrl ? (
        <img src={camera.lastSnapshotDataUrl} alt={`${camera.name} snapshot`} />
      ) : (
        <div className="empty-state" style={{ height: '100%', justifyContent: 'center' }}>
          <span>No snapshot loaded yet</span>
        </div>
      )}
      {isConnecting && (
        <div className="viewport-connecting-badge">
          <Loader2 size={13} className="spin" />
          <span>Connecting live feed…</span>
        </div>
      )}
    </>
  )
}
