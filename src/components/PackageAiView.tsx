import { useState } from 'react'
import {
  Bell,
  CheckCircle2,
  PackageCheck,
  PackageSearch,
  Sparkles,
  Trash2,
  Volume2,
} from 'lucide-react'
import type {
  AlertSoundProfile,
  AppSettings,
  AppSettingsPatch,
  PackageDetectionRecord,
  RingCameraInfo,
} from '@shared/types'
import { playAlertChime } from '@/utils/audioChime'
import { formatRelativeTime } from '@/utils/format'

interface PackageAiViewProps {
  cameras: RingCameraInfo[]
  settings: AppSettings
  detections: PackageDetectionRecord[]
  onUpdateSettings: (patch: AppSettingsPatch) => Promise<void>
  onScanCamera: (cameraId: string) => Promise<void>
  onClearDetections: () => Promise<void>
  onTestAlert: () => Promise<void>
  onGoToSettings: () => void
}

const SOUND_OPTIONS: Array<{ value: AlertSoundProfile; label: string }> = [
  { value: 'crisp-chime', label: 'Crisp Tri-Tone Chime' },
  { value: 'doorbell-double', label: 'Doorbell Double-Tone' },
  { value: 'soft-pulse', label: 'Soft Pulse' },
  { value: 'urgent-radar', label: 'Urgent Radar Alert' },
  { value: 'none', label: 'Silent (Toast Only)' },
]

export function PackageAiView({
  cameras,
  settings,
  detections,
  onUpdateSettings,
  onScanCamera,
  onClearDetections,
  onTestAlert,
  onGoToSettings,
}: PackageAiViewProps) {
  const ai = settings.packageAi
  const [selectedScanCameraId, setSelectedScanCameraId] = useState(
    cameras[0]?.id ?? '',
  )
  const [scanning, setScanning] = useState(false)

  const hasActiveKey =
    ai.provider === 'openai' ? ai.hasOpenaiKey : ai.hasGeminiKey

  const toggleMonitoredCamera = (cameraId: string) => {
    const current = ai.monitoredCameraIds
    const next = current.includes(cameraId)
      ? current.filter((id) => id !== cameraId)
      : [...current, cameraId]
    void onUpdateSettings({ packageAi: { monitoredCameraIds: next } })
  }

  return (
    <div className="ai-grid">
      <section className="panel">
        <div className="panel-header">
          <h3>Package Detection Rules</h3>
          <span className={`chip ${ai.enabled ? 'ok' : ''}`}>
            {ai.enabled ? 'Monitoring Active' : 'Paused'}
          </span>
        </div>

        <div className="panel-body form-stack">
          <div className="toggle-row">
            <div>
              <div className="toggle-label-main">Enable AI Package Automation</div>
              <div className="toggle-label-sub">
                Analyze snapshots automatically using{' '}
                {ai.provider === 'openai'
                  ? `OpenAI (${ai.openaiModel})`
                  : `Gemini (${ai.geminiModel})`}
              </div>
            </div>
            <button
              id="toggle-ai-enabled"
              type="button"
              role="switch"
              aria-checked={ai.enabled}
              className={`switch ${ai.enabled ? 'on' : ''}`}
              onClick={() =>
                void onUpdateSettings({ packageAi: { enabled: !ai.enabled } })
              }
            />
          </div>

          {!hasActiveKey && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                background: 'var(--status-warn-soft)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                fontSize: 12.5,
                color: '#fde68a',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              <span>
                No {ai.provider === 'openai' ? 'OpenAI' : 'Gemini'} API key saved yet.
                {settings.mode === 'demo'
                  ? ' Demo simulator active.'
                  : ' Add key in Settings to scan live cameras.'}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={onGoToSettings}
              >
                Configure Key
              </button>
            </div>
          )}

          <div className="field">
            <label>Monitored Cameras (leave unselected for all cameras)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {cameras.map((cam) => {
                const selected = ai.monitoredCameraIds.includes(cam.id)
                return (
                  <button
                    key={cam.id}
                    type="button"
                    className={`btn btn-sm ${selected ? 'btn-primary' : ''}`}
                    onClick={() => toggleMonitoredCamera(cam.id)}
                  >
                    {cam.name}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="toggle-row">
            <div>
              <div className="toggle-label-main">Scan on Camera Motion</div>
              <div className="toggle-label-sub">
                Inspect frame whenever Ring reports motion
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={ai.triggerOnMotion}
              className={`switch ${ai.triggerOnMotion ? 'on' : ''}`}
              onClick={() =>
                void onUpdateSettings({
                  packageAi: { triggerOnMotion: !ai.triggerOnMotion },
                })
              }
            />
          </div>

          <div className="toggle-row">
            <div>
              <div className="toggle-label-main">Scan on Doorbell Ring</div>
              <div className="toggle-label-sub">
                Inspect doorstep frame when visitor presses doorbell
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={ai.triggerOnDoorbell}
              className={`switch ${ai.triggerOnDoorbell ? 'on' : ''}`}
              onClick={() =>
                void onUpdateSettings({
                  packageAi: { triggerOnDoorbell: !ai.triggerOnDoorbell },
                })
              }
            />
          </div>

          <div className="field">
            <label htmlFor="ai-sound">Alert Sound</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                id="ai-sound"
                className="select"
                value={ai.alertSound}
                onChange={(e) =>
                  void onUpdateSettings({
                    packageAi: {
                      alertSound: e.target.value as AlertSoundProfile,
                    },
                  })
                }
              >
                {SOUND_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => playAlertChime(ai.alertSound, ai.alertVolume)}
                title="Preview alert chime"
              >
                <Volume2 size={14} />
                Preview
              </button>
            </div>
          </div>

          <button
            id="btn-test-package-alert"
            type="button"
            className="btn btn-primary"
            onClick={() => void onTestAlert()}
          >
            <Bell size={14} />
            Test Alert &amp; Sound
          </button>

          <details className="advanced-drawer">
            <summary>Advanced Detection Options</summary>
            <div className="advanced-drawer-body">
              <div className="field">
                <label htmlFor="ai-hint">Custom Porch / Drop-Zone Hint (optional)</label>
                <input
                  id="ai-hint"
                  type="text"
                  className="input"
                  placeholder="e.g. Couriers leave boxes beside the brick pillar or steps"
                  value={ai.customPromptHint}
                  onChange={(e) =>
                    void onUpdateSettings({
                      packageAi: { customPromptHint: e.target.value },
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="ai-interval">Periodic Background Scan Interval</label>
                <select
                  id="ai-interval"
                  className="select"
                  value={ai.intervalMinutes}
                  onChange={(e) =>
                    void onUpdateSettings({
                      packageAi: { intervalMinutes: Number(e.target.value) },
                    })
                  }
                >
                  <option value={0}>Event-triggered only (Recommended)</option>
                  <option value={5}>Every 5 minutes</option>
                  <option value={10}>Every 10 minutes</option>
                  <option value={15}>Every 15 minutes</option>
                  <option value={30}>Every 30 minutes</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="ai-confidence">
                  Minimum Confidence:{' '}
                  <span className="mono">{Math.round(ai.minConfidence * 100)}%</span>
                </label>
                <input
                  id="ai-confidence"
                  type="range"
                  min={50}
                  max={95}
                  step={5}
                  value={Math.round(ai.minConfidence * 100)}
                  onChange={(e) =>
                    void onUpdateSettings({
                      packageAi: { minConfidence: Number(e.target.value) / 100 },
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="ai-cooldown">
                  Alert Cooldown:{' '}
                  <span className="mono">{ai.cooldownMinutes} min</span>
                </label>
                <input
                  id="ai-cooldown"
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  value={ai.cooldownMinutes}
                  onChange={(e) =>
                    void onUpdateSettings({
                      packageAi: { cooldownMinutes: Number(e.target.value) },
                    })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="ai-volume">
                  Alert Volume:{' '}
                  <span className="mono">{Math.round(ai.alertVolume * 100)}%</span>
                </label>
                <input
                  id="ai-volume"
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={Math.round(ai.alertVolume * 100)}
                  onChange={(e) =>
                    void onUpdateSettings({
                      packageAi: { alertVolume: Number(e.target.value) / 100 },
                    })
                  }
                />
              </div>

              <div className="toggle-row" style={{ padding: '4px 0' }}>
                <div>
                  <div className="toggle-label-main">Windows Desktop Toast</div>
                  <div className="toggle-label-sub">
                    Show native Windows notification on package detection
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={ai.desktopNotifications}
                  className={`switch ${ai.desktopNotifications ? 'on' : ''}`}
                  onClick={() =>
                    void onUpdateSettings({
                      packageAi: {
                        desktopNotifications: !ai.desktopNotifications,
                      },
                    })
                  }
                />
              </div>
            </div>
          </details>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3>AI Vision Detection History</h3>
            <span className="chip">
              {detections.filter((d) => d.packageDetected).length} packages found
            </span>
          </div>

          <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
            <select
              aria-label="Camera to scan for packages"
              className="select"
              style={{ width: 205, padding: '5px 8px', fontSize: 12.5 }}
              value={selectedScanCameraId || cameras[0]?.id || ''}
              onChange={(e) => setSelectedScanCameraId(e.target.value)}
            >
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <button
              id="btn-scan-packages-now"
              type="button"
              className="btn btn-warn btn-sm"
              disabled={scanning || cameras.length === 0}
              onClick={async () => {
                const target = selectedScanCameraId || cameras[0]?.id
                if (!target) return
                setScanning(true)
                try {
                  await onScanCamera(target)
                } finally {
                  setScanning(false)
                }
              }}
            >
              <PackageSearch size={14} />
              {scanning ? 'Analyzing…' : 'Run Vision Scan'}
            </button>

            {detections.length > 0 && (
              <button
                type="button"
                className="btn btn-icon"
                title="Clear detection history"
                onClick={() => void onClearDetections()}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="panel-body">
          {detections.length === 0 ? (
            <div className="empty-state">
              <Sparkles size={28} />
              <strong>No package scans recorded yet</strong>
              <span>
                Click &ldquo;Run Vision Scan&rdquo; to inspect a camera snapshot with
                Cloud Vision AI, or trigger an automatic motion/doorbell event.
              </span>
            </div>
          ) : (
            <div className="form-stack" style={{ gap: 10 }}>
              {detections.map((item) => (
                <article
                  key={item.id}
                  className={`detection-card ${item.packageDetected ? 'detected' : ''}`}
                >
                  {item.snapshotDataUrl ? (
                    <img
                      src={item.snapshotDataUrl}
                      alt={item.cameraName}
                      className="detection-thumb"
                    />
                  ) : (
                    <div
                      className="detection-thumb"
                      style={{ display: 'grid', placeItems: 'center' }}
                    >
                      <PackageSearch size={22} color="#6c7f96" />
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong>{item.cameraName}</strong>
                        {item.rawError ? (
                          <span className="chip alert">Scan Error</span>
                        ) : item.packageDetected ? (
                          <span className="chip warn">
                            <PackageCheck size={12} />
                            {item.packageCount} Package
                            {item.packageCount > 1 ? 's' : ''} Detected
                          </span>
                        ) : (
                          <span className="chip ok">
                            <CheckCircle2 size={12} />
                            Porch Clear
                          </span>
                        )}
                        {item.carrierHint && (
                          <span className="chip accent">{item.carrierHint}</span>
                        )}
                      </div>
                      <span
                        className="mono"
                        style={{ fontSize: 11.5, color: 'var(--text-muted)' }}
                      >
                        {formatRelativeTime(item.timestamp)}
                      </span>
                    </div>

                    <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                      {item.summary}
                    </div>

                    {item.placement && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        Placement: {item.placement}
                      </div>
                    )}

                    <div
                      className="mono"
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 12,
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                        marginTop: 2,
                      }}
                    >
                      <span>Confidence: {Math.round(item.confidence * 100)}%</span>
                      <span>
                        Engine: {item.provider} ({item.model})
                      </span>
                      <span>Trigger: {item.trigger}</span>
                      <span>{item.latencyMs}ms</span>
                      {item.notified && (
                        <span style={{ color: '#4ade80' }}>Alert Sent</span>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
