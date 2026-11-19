import { useState } from 'react'
import {
  CheckCircle2,
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
  RingCameraInfo,
} from '@shared/types'

interface SettingsViewProps {
  connection: ConnectionStatus
  settings: AppSettings
  cameras: RingCameraInfo[]
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
  onChooseFailoverFolder: () => Promise<void>
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
      {/* Column 1: Ring Account */}
      <section className="panel">
        <div className="panel-header">
          <h3>Ring Account</h3>
          <div className="segmented">
            <button
              type="button"
              className={settings.mode === 'demo' ? 'active' : ''}
              onClick={() => void onSwitchMode('demo')}
            >
              Demo
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
                    ? `${connection.accountLabel ?? 'Ring Connected'} (${connection.cameraCount} cams, ${connection.sensorCount} sensors)`
                    : 'Ring Disconnected'
                  : 'Demo Mode (Simulated devices)'}
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
                  : 'Credentials are stored locally using Windows encryption.'}
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
            <div className="field">
              <label htmlFor="ring-email">Ring Email</label>
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
                ? 'Signing in…'
                : twoFactorPrompt
                  ? 'Verify 2FA & Connect'
                  : 'Sign In to Ring'}
            </button>
          </form>

          <details className="advanced-drawer">
            <summary>Sign in with Refresh Token (Advanced)</summary>
            <div className="advanced-drawer-body">
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
                className="btn btn-sm"
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
                <PlugZap size={13} />
                {tokenBusy ? 'Connecting…' : 'Connect Token'}
              </button>
            </div>
          </details>
        </div>
      </section>

      {/* Column 2: Cloud Vision AI + App Preferences */}
      <div className="form-stack">
        <section className="panel">
          <div className="panel-header">
            <h3>Cloud Vision AI</h3>
            <span className="chip accent">
              <ShieldCheck size={12} />
              Encrypted
            </span>
          </div>

          <div className="panel-body form-stack">
            <div className="field">
              <label htmlFor="ai-provider">Provider</label>
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
                <option value="gemini">Google Gemini Vision</option>
              </select>
            </div>

            {ai.provider === 'openai' ? (
              <>
                <div className="field">
                  <label htmlFor="openai-model">Model</label>
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
                  <label htmlFor="gemini-model">Model</label>
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
                    <option value="gemini-3-flash-preview">
                      gemini-3-flash-preview (Recommended)
                    </option>
                    <option value="gemini-3.5-flash-lite">
                      gemini-3.5-flash-lite (Fastest)
                    </option>
                    <option value="gemini-3.8-flash">
                      gemini-3.8-flash (High accuracy)
                    </option>
                    <option value="gemini-3.1-pro-preview">
                      gemini-3.1-pro-preview (Maximum precision)
                    </option>
                    <option value="gemini-4-hydrogen">
                      gemini-4-hydrogen (Next-gen fast)
                    </option>
                    {![
                      'gemini-3.5-flash-lite',
                      'gemini-3-flash-preview',
                      'gemini-3.8-flash',
                      'gemini-3.1-pro-preview',
                      'gemini-4-hydrogen',
                    ].includes(ai.geminiModel) && (
                      <option value={ai.geminiModel}>{ai.geminiModel}</option>
                    )}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="gemini-key">
                    Gemini API Key{' '}
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
                {testingAi ? 'Testing…' : 'Test Connection'}
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
            <h3>Windows &amp; App Preferences</h3>
          </div>

          <div className="panel-body form-stack">
            <div className="toggle-row">
              <div>
                <div className="toggle-label-main">Launch on Windows Startup</div>
                <div className="toggle-label-sub">
                  Resume 24/7 recording automatically after reboot
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.launchAtLogin}
                className={`switch ${settings.launchAtLogin ? 'on' : ''}`}
                onClick={() =>
                  void onUpdateSettings({
                    launchAtLogin: !settings.launchAtLogin,
                  })
                }
              />
            </div>

            <div className="toggle-row">
              <div>
                <div className="toggle-label-main">Minimize to System Tray</div>
                <div className="toggle-label-sub">
                  Keep recording and alerts active when the window closes
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
                  Start quietly in the background on launch
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

            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              External drives, failover folders, and 24/7 retention rules are managed in{' '}
              <strong>NVR &amp; Storage</strong>.
            </p>

            <details className="advanced-drawer">
              <summary>Advanced Recording &amp; FFmpeg Options</summary>
              <div className="advanced-drawer-body">
                <div className="field">
                  <label htmlFor="default-duration">Manual Clip Length</label>
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

                <div className="toggle-row">
                  <div>
                    <div className="toggle-label-main">Auto-Record on Motion</div>
                    <div className="toggle-label-sub">
                      Save an extra clip when motion triggers
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
                    <div className="toggle-label-main">Auto-Record on Doorbell</div>
                    <div className="toggle-label-sub">
                      Save a clip when someone rings the doorbell
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
                    <div className="toggle-label-main">Auto-Record on Package Alert</div>
                    <div className="toggle-label-sub">
                      Save a clip whenever AI detects a package
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
                  <label htmlFor="ffmpeg-path">Custom FFmpeg Path (optional)</label>
                  <input
                    id="ffmpeg-path"
                    type="text"
                    className="input mono"
                    placeholder="Leave blank to use bundled ffmpeg"
                    value={settings.ffmpegPath}
                    onChange={(e) =>
                      void onUpdateSettings({ ffmpegPath: e.target.value })
                    }
                  />
                </div>
              </div>
            </details>
          </div>
        </section>
      </div>
    </div>
  )
}
