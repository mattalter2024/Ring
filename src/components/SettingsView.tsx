import { useState } from 'react'
import {
  CheckCircle2,
  FolderOpen,
  KeyRound,
  Link2,
  PlugZap,
  ShieldCheck,
  Unplug,
} from 'lucide-react'
import type {
  AiProvider,
  AppMode,
  AppSettings,
  AppSettingsPatch,
  ConnectionStatus,
  RingAuthStepResult,
} from '@shared/types'

interface SettingsViewProps {
  connection: ConnectionStatus
  settings: AppSettings
  onSwitchMode: (mode: AppMode) => Promise<void>
  onLoginCredentials: (params: {
    email: string
    password: string
    twoFactorCode?: string
  }) => Promise<RingAuthStepResult>
  onConnectToken: (token: string) => Promise<void>
  onDisconnectRing: () => Promise<void>
  onUpdateSettings: (patch: AppSettingsPatch) => Promise<void>
  onChooseRecordingsFolder: () => Promise<void>
  onTestAiConnection: () => Promise<{
    ok: boolean
    message: string
    latencyMs?: number
  }>
}

export function SettingsView({
  connection,
  settings,
  onSwitchMode,
  onLoginCredentials,
  onConnectToken,
  onDisconnectRing,
  onUpdateSettings,
  onChooseRecordingsFolder,
  onTestAiConnection,
}: SettingsViewProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [twoFactorPrompt, setTwoFactorPrompt] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  const [refreshTokenInput, setRefreshTokenInput] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)

  const [openaiKeyInput, setOpenaiKeyInput] = useState('')
  const [geminiKeyInput, setGeminiKeyInput] = useState('')
  const [aiTestResult, setAiTestResult] = useState<{
    ok: boolean
    message: string
    latencyMs?: number
  } | null>(null)
  const [testingAi, setTestingAi] = useState(false)

  const ai = settings.packageAi

  const handleRingLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError(null)
    setAuthBusy(true)
    try {
      const res = await onLoginCredentials({
        email,
        password,
        twoFactorCode: twoFactorPrompt ? twoFactorCode : undefined,
      })
      if (res.status === '2fa-required') {
        setTwoFactorPrompt(
          res.prompt ?? 'Enter the 2FA verification code sent by Ring.',
        )
      } else if (res.status === 'error') {
        setAuthError(res.error ?? 'Authentication failed.')
      } else {
        setTwoFactorPrompt(null)
        setTwoFactorCode('')
        setPassword('')
      }
    } finally {
      setAuthBusy(false)
    }
  }

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-header">
          <h3>Ring Account &amp; Device Connection</h3>
          <div className="segmented">
            <button
              type="button"
              className={settings.mode === 'demo' ? 'active' : ''}
              onClick={() => void onSwitchMode('demo')}
            >
              Demo Mode
            </button>
            <button
              type="button"
              className={settings.mode === 'live' ? 'active' : ''}
              onClick={() => void onSwitchMode('live')}
            >
              Live Ring
            </button>
          </div>
        </div>

        <div className="panel-body form-stack">
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <div>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  color:
                    connection.mode === 'live' && !connection.connected
                      ? '#fca5a5'
                      : undefined,
                }}
              >
                {connection.mode === 'live'
                  ? connection.connected
                    ? `${connection.accountLabel ?? 'Ring Account Active'} (${connection.cameraCount} camera(s), ${connection.sensorCount} sensor(s))`
                    : 'Live Ring Disconnected — Action Needed'
                  : 'Demo Mode Active (3 simulated cameras, 5 sensors)'}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: connection.error ? '#fca5a5' : 'var(--text-muted)',
                  wordBreak: 'break-word',
                }}
              >
                {connection.error
                  ? connection.error
                  : 'Refresh tokens are encrypted locally via Windows DPAPI safeStorage and auto-rotated.'}
              </div>
            </div>
            {settings.hasRingToken && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void onDisconnectRing()}
              >
                <Unplug size={13} />
                Disconnect
              </button>
            )}
          </div>

          <form className="form-stack" onSubmit={(e) => void handleRingLogin(e)}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              Sign In with Ring Credentials (2FA Supported)
            </div>

            <div className="field">
              <label htmlFor="ring-email">Ring Account Email</label>
              <input
                id="ring-email"
                type="email"
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="ring-password">Ring Password</label>
              <input
                id="ring-password"
                type="password"
                className="input"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {twoFactorPrompt && (
              <div className="field">
                <label htmlFor="ring-2fa" style={{ color: '#fbbf24' }}>
                  {twoFactorPrompt}
                </label>
                <input
                  id="ring-2fa"
                  type="text"
                  className="input mono"
                  placeholder="6-digit 2FA code"
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  required
                />
              </div>
            )}

            {authError && (
              <div style={{ fontSize: 12.5, color: '#fca5a5' }}>{authError}</div>
            )}

            <button
              id="btn-ring-signin"
              type="submit"
              className="btn btn-primary"
              disabled={authBusy}
            >
              <Link2 size={14} />
              {authBusy
                ? 'Authenticating…'
                : twoFactorPrompt
                  ? 'Verify 2FA & Connect'
                  : 'Sign In to Ring'}
            </button>
          </form>

          <div
            style={{
              borderTop: '1px solid var(--border-subtle)',
              paddingTop: 14,
            }}
            className="form-stack"
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              Or Connect with Ring Refresh Token
            </div>
            <div className="field">
              <label htmlFor="ring-token">
                Token from <code className="mono">npx -p ring-client-api ring-auth-cli</code>
              </label>
              <input
                id="ring-token"
                type="password"
                className="input mono"
                placeholder="Paste refresh token…"
                value={refreshTokenInput}
                onChange={(e) => setRefreshTokenInput(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn"
              disabled={tokenBusy || !refreshTokenInput.trim()}
              onClick={async () => {
                setTokenBusy(true)
                try {
                  await onConnectToken(refreshTokenInput.trim())
                  setRefreshTokenInput('')
                } finally {
                  setTokenBusy(false)
                }
              }}
            >
              <PlugZap size={14} />
              {tokenBusy ? 'Connecting…' : 'Connect Using Refresh Token'}
            </button>
          </div>
        </div>
      </section>

      <div className="form-stack">
        <section className="panel">
          <div className="panel-header">
            <h3>Cloud Vision AI (Package Detection)</h3>
            <span className="chip accent">
              <ShieldCheck size={12} />
              DPAPI Encrypted
            </span>
          </div>

          <div className="panel-body form-stack">
            <div className="field">
              <label htmlFor="ai-provider">Vision Provider</label>
              <select
                id="ai-provider"
                className="select"
                value={ai.provider}
                onChange={(e) =>
                  void onUpdateSettings({
                    packageAi: { provider: e.target.value as AiProvider },
                  })
                }
              >
                <option value="openai">OpenAI Vision (GPT-4o / 4.1)</option>
                <option value="gemini">Google Gemini Vision (2.5 / 2.0 Flash)</option>
              </select>
            </div>

            {ai.provider === 'openai' ? (
              <>
                <div className="field">
                  <label htmlFor="openai-model">OpenAI Vision Model</label>
                  <select
                    id="openai-model"
                    className="select"
                    value={ai.openaiModel}
                    onChange={(e) =>
                      void onUpdateSettings({
                        packageAi: { openaiModel: e.target.value },
                      })
                    }
                  >
                    <option value="gpt-4o-mini">gpt-4o-mini (Fast &amp; low cost)</option>
                    <option value="gpt-4.1-mini">gpt-4.1-mini (Balanced)</option>
                    <option value="gpt-4o">gpt-4o (Maximum accuracy)</option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="openai-key">
                    OpenAI API Key{' '}
                    {ai.hasOpenaiKey && (
                      <span className="chip ok" style={{ marginLeft: 6 }}>
                        <CheckCircle2 size={11} />
                        Saved
                      </span>
                    )}
                  </label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      id="openai-key"
                      type="password"
                      className="input mono"
                      placeholder={
                        ai.hasOpenaiKey
                          ? 'Enter new key to replace saved key…'
                          : 'sk-…'
                      }
                      value={openaiKeyInput}
                      onChange={(e) => setOpenaiKeyInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={!openaiKeyInput.trim()}
                      onClick={async () => {
                        await onUpdateSettings({
                          packageAi: { openaiApiKey: openaiKeyInput.trim() },
                        })
                        setOpenaiKeyInput('')
                      }}
                    >
                      <KeyRound size={13} />
                      Save
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="gemini-model">Google Gemini Model</label>
                  <select
                    id="gemini-model"
                    className="select"
                    value={ai.geminiModel}
                    onChange={(e) =>
                      void onUpdateSettings({
                        packageAi: { geminiModel: e.target.value },
                      })
                    }
                  >
                    <option value="gemini-2.5-flash">
                      gemini-2.5-flash (Recommended)
                    </option>
                    <option value="gemini-2.0-flash">gemini-2.0-flash</option>
                    <option value="gemini-2.5-pro">
                      gemini-2.5-pro (Highest precision)
                    </option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="gemini-key">
                    Google Gemini API Key{' '}
                    {ai.hasGeminiKey && (
                      <span className="chip ok" style={{ marginLeft: 6 }}>
                        <CheckCircle2 size={11} />
                        Saved
                      </span>
                    )}
                  </label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      id="gemini-key"
                      type="password"
                      className="input mono"
                      placeholder={
                        ai.hasGeminiKey
                          ? 'Enter new key to replace saved key…'
                          : 'AIza…'
                      }
                      value={geminiKeyInput}
                      onChange={(e) => setGeminiKeyInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={!geminiKeyInput.trim()}
                      onClick={async () => {
                        await onUpdateSettings({
                          packageAi: { geminiApiKey: geminiKeyInput.trim() },
                        })
                        setGeminiKeyInput('')
                      }}
                    >
                      <KeyRound size={13} />
                      Save
                    </button>
                  </div>
                </div>
              </>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                id="btn-test-ai"
                type="button"
                className="btn btn-sm"
                disabled={testingAi}
                onClick={async () => {
                  setTestingAi(true)
                  try {
                    const res = await onTestAiConnection()
                    setAiTestResult(res)
                  } finally {
                    setTestingAi(false)
                  }
                }}
              >
                {testingAi ? 'Testing…' : 'Test Vision API Connection'}
              </button>
              {aiTestResult && (
                <span
                  style={{
                    fontSize: 12,
                    color: aiTestResult.ok ? '#4ade80' : '#fca5a5',
                  }}
                >
                  {aiTestResult.message}
                  {aiTestResult.latencyMs ? ` (${aiTestResult.latencyMs}ms)` : ''}
                </span>
              )}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Windows Storage &amp; Tray Preferences</h3>
          </div>

          <div className="panel-body form-stack">
            <div className="field">
              <label htmlFor="rec-dir">Local Recordings Folder</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id="rec-dir"
                  type="text"
                  className="input mono"
                  value={settings.recordingsDir}
                  readOnly
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void onChooseRecordingsFolder()}
                >
                  <FolderOpen size={14} />
                  Browse
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="default-duration">Default Capture Clip Length</label>
              <select
                id="default-duration"
                className="select"
                value={settings.defaultCaptureSeconds}
                onChange={(e) =>
                  void onUpdateSettings({
                    defaultCaptureSeconds: Number(e.target.value),
                  })
                }
              >
                <option value={15}>15 seconds</option>
                <option value={30}>30 seconds</option>
                <option value={45}>45 seconds</option>
                <option value={60}>60 seconds</option>
                <option value={120}>120 seconds</option>
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="field">
                <label htmlFor="max-storage-gb">Local Storage Quota Cap</label>
                <select
                  id="max-storage-gb"
                  className="select"
                  value={settings.maxStorageGb}
                  onChange={(e) =>
                    void onUpdateSettings({ maxStorageGb: Number(e.target.value) })
                  }
                >
                  <option value={5}>5 GB</option>
                  <option value={10}>10 GB</option>
                  <option value={25}>25 GB (Recommended)</option>
                  <option value={50}>50 GB</option>
                  <option value={100}>100 GB</option>
                  <option value={250}>250 GB</option>
                  <option value={0}>Unlimited</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="retention-days">Auto-Delete Older Than</label>
                <select
                  id="retention-days"
                  className="select"
                  value={settings.retentionDays}
                  onChange={(e) =>
                    void onUpdateSettings({ retentionDays: Number(e.target.value) })
                  }
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days (Recommended)</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                  <option value={0}>Keep forever</option>
                </select>
              </div>
            </div>

            <div className="toggle-row">
              <div>
                <div className="toggle-label-main">Auto-Record Locally on Motion</div>
                <div className="toggle-label-sub">
                  Save MP4 clip to local storage whenever a camera detects motion
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoRecordOnMotion}
                className={`switch ${settings.autoRecordOnMotion ? 'on' : ''}`}
                onClick={() =>
                  void onUpdateSettings({
                    autoRecordOnMotion: !settings.autoRecordOnMotion,
                  })
                }
              />
            </div>

            <div className="toggle-row">
              <div>
                <div className="toggle-label-main">Auto-Record Locally on Doorbell Press</div>
                <div className="toggle-label-sub">
                  Capture doorbell ring clips directly into your local vault
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoRecordOnDoorbell}
                className={`switch ${settings.autoRecordOnDoorbell ? 'on' : ''}`}
                onClick={() =>
                  void onUpdateSettings({
                    autoRecordOnDoorbell: !settings.autoRecordOnDoorbell,
                  })
                }
              />
            </div>

            <div className="toggle-row">
              <div>
                <div className="toggle-label-main">Auto-Record on AI Package Detection</div>
                <div className="toggle-label-sub">
                  Save a local MP4 clip whenever Cloud Vision detects a package
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoRecordOnPackage}
                className={`switch ${settings.autoRecordOnPackage ? 'on' : ''}`}
                onClick={() =>
                  void onUpdateSettings({
                    autoRecordOnPackage: !settings.autoRecordOnPackage,
                  })
                }
              />
            </div>

            <div className="field">
              <label htmlFor="ffmpeg-path">
                Custom FFmpeg Path (optional — bundled binary used by default)
              </label>
              <input
                id="ffmpeg-path"
                type="text"
                className="input mono"
                placeholder="Leave blank to use built-in / PATH ffmpeg.exe"
                value={settings.ffmpegPath}
                onChange={(e) =>
                  void onUpdateSettings({ ffmpegPath: e.target.value })
                }
              />
            </div>

            <div className="toggle-row">
              <div>
                <div className="toggle-label-main">Minimize to Windows System Tray</div>
                <div className="toggle-label-sub">
                  Keep monitoring sensors &amp; AI package alerts when window closes
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.minimizeToTray}
                className={`switch ${settings.minimizeToTray ? 'on' : ''}`}
                onClick={() =>
                  void onUpdateSettings({ minimizeToTray: !settings.minimizeToTray })
                }
              />
            </div>

            <div className="toggle-row">
              <div>
                <div className="toggle-label-main">Start Minimized in Tray</div>
                <div className="toggle-label-sub">
                  Launch quietly in background on Windows startup
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.startMinimized}
                className={`switch ${settings.startMinimized ? 'on' : ''}`}
                onClick={() =>
                  void onUpdateSettings({ startMinimized: !settings.startMinimized })
                }
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
