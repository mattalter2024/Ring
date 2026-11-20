import { useState } from 'react'
import {
  Bell,
  CheckCircle2,
  Download,
  ExternalLink,
  FileKey2,
  FolderOpen,
  KeyRound,
  Link2,
  Lock,
  LogOut,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Unplug,
  Upload,
} from 'lucide-react'
import type {
  AiProvider,
  AppMode,
  AppSettings,
  AppSettingsPatch,
  AuthStatus,
  ConnectionStatus,
  RingAuthStepResult,
  RingCameraInfo,
  TlsStatus,
} from '@shared/types'

interface SettingsViewProps {
  connection: ConnectionStatus
  settings: AppSettings
  cameras: RingCameraInfo[]
  authStatus: AuthStatus
  tlsStatus?: TlsStatus
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
  onUpdateAuthPassword: (params: {
    currentPassword?: string
    newPassword: string
  }) => Promise<{ ok: boolean; authEnabled: boolean; error?: string }>
  onLogout: () => Promise<void>
  onRegenerateSelfSignedCert?: (customHostnames?: string[]) => Promise<TlsStatus>
  onUploadCustomTlsCert?: (params: {
    certPem: string
    keyPem: string
    caPem?: string
  }) => Promise<TlsStatus>
  onUseCustomTlsCertFiles?: (params: {
    certPath: string
    keyPath: string
    caPath?: string
  }) => Promise<TlsStatus>
  onSwitchToSelfSignedCert?: () => Promise<TlsStatus>
}

export function SettingsView({
  connection,
  settings,
  authStatus,
  tlsStatus,
  onSwitchMode,
  onLoginCredentials,
  onConnectToken,
  onDisconnectRing,
  onUpdateSettings,
  onTestAiConnection,
  onUpdateAuthPassword,
  onLogout,
  onRegenerateSelfSignedCert,
  onUploadCustomTlsCert,
  onUseCustomTlsCertFiles,
  onSwitchToSelfSignedCert,
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

  const [currentWebPassword, setCurrentWebPassword] = useState('')
  const [newWebPassword, setNewWebPassword] = useState('')
  const [webAuthMsg, setWebAuthMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [webAuthBusy, setWebAuthBusy] = useState(false)
  const [notifPerm, setNotifPerm] = useState<string>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  )

  const tlsCfg = settings.tls
  const [tlsTab, setTlsTab] = useState<'self-signed' | 'custom-pem' | 'custom-files'>(
    tlsCfg?.mode ?? 'self-signed',
  )
  const [sanInput, setSanInput] = useState(() => (tlsCfg?.customHostnames ?? []).join(', '))
  const [certPemInput, setCertPemInput] = useState('')
  const [keyPemInput, setKeyPemInput] = useState('')
  const [caPemInput, setCaPemInput] = useState('')
  const [certPathInput, setCertPathInput] = useState(() => tlsCfg?.customCertPath ?? '')
  const [keyPathInput, setKeyPathInput] = useState(() => tlsCfg?.customKeyPath ?? '')
  const [caPathInput, setCaPathInput] = useState(() => tlsCfg?.customCaPath ?? '')
  const [tlsBusy, setTlsBusy] = useState(false)
  const [tlsMsg, setTlsMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const ai = settings.packageAi

  const readFileText = async (file: File | undefined, setter: (v: string) => void) => {
    if (!file) return
    const text = await file.text()
    setter(text)
  }

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
                  : 'Credentials are encrypted locally on your RingWatch backend server.'}
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
                    <option value="gpt-4.1-nano">gpt-4.1-nano (Ultra low cost)</option>
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
            <h3>Web Access &amp; Notifications</h3>
            <span className={`chip ${authStatus.authEnabled ? 'ok' : ''}`}>
              <Lock size={11} />
              {authStatus.authEnabled ? 'Login Enabled' : 'Open (No Password)'}
            </span>
          </div>

          <div className="panel-body form-stack">
            <div className="toggle-row">
              <div>
                <div className="toggle-label-main">Browser Desktop Alerts</div>
                <div className="toggle-label-sub">
                  {notifPerm === 'granted'
                    ? 'Enabled — package & NVR alerts will pop up in this browser'
                    : notifPerm === 'denied'
                      ? 'Blocked in browser site settings'
                      : 'Allow native browser notifications for package deliveries'}
                </div>
              </div>
              <button
                type="button"
                className={`btn btn-sm ${notifPerm === 'granted' ? '' : 'btn-primary'}`}
                disabled={notifPerm === 'granted' || notifPerm === 'unsupported'}
                onClick={async () => {
                  if (typeof Notification === 'undefined') return
                  const perm = await Notification.requestPermission()
                  setNotifPerm(perm)
                }}
              >
                <Bell size={13} />
                {notifPerm === 'granted' ? 'Enabled' : 'Enable Alerts'}
              </button>
            </div>

            {authStatus.managedByEnv ? (
              <div
                style={{
                  padding: '9px 11px',
                  borderRadius: 7,
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                }}
              >
                Web login password is active via the{' '}
                <code className="mono">RINGWATCH_AUTH_PASSWORD</code> environment
                variable.
              </div>
            ) : (
              <div className="form-stack" style={{ gap: 8 }}>
                {authStatus.authEnabled && (
                  <div className="field">
                    <label htmlFor="web-auth-current">Current Web Password</label>
                    <input
                      id="web-auth-current"
                      type="password"
                      className="input"
                      placeholder="Required to change or disable login"
                      value={currentWebPassword}
                      onChange={(e) => setCurrentWebPassword(e.target.value)}
                    />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="web-auth-new">
                    {authStatus.authEnabled
                      ? 'New Web Password (leave blank to disable login)'
                      : 'Optional Web Login Password'}
                  </label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      id="web-auth-new"
                      type="password"
                      className="input"
                      placeholder={
                        authStatus.authEnabled
                          ? 'New password or empty to disable…'
                          : 'Set a password to protect LAN access…'
                      }
                      value={newWebPassword}
                      onChange={(e) => setNewWebPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={
                        webAuthBusy || (!authStatus.authEnabled && !newWebPassword.trim())
                      }
                      onClick={async () => {
                        setWebAuthBusy(true)
                        setWebAuthMsg(null)
                        try {
                          const res = await onUpdateAuthPassword({
                            currentPassword: currentWebPassword || undefined,
                            newPassword: newWebPassword,
                          })
                          if (res.ok) {
                            setCurrentWebPassword('')
                            setNewWebPassword('')
                            setWebAuthMsg({
                              ok: true,
                              text: res.authEnabled
                                ? 'Web login password saved.'
                                : 'Web login gate disabled.',
                            })
                          } else {
                            setWebAuthMsg({
                              ok: false,
                              text: res.error ?? 'Failed to update password.',
                            })
                          }
                        } finally {
                          setWebAuthBusy(false)
                        }
                      }}
                    >
                      <Lock size={13} />
                      {authStatus.authEnabled && !newWebPassword.trim()
                        ? 'Disable'
                        : 'Save'}
                    </button>
                  </div>
                </div>
                {webAuthMsg && (
                  <div
                    style={{
                      fontSize: 12,
                      color: webAuthMsg.ok ? '#4ade80' : '#fca5a5',
                    }}
                  >
                    {webAuthMsg.text}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a
                href="/api/logs/download"
                download
                className="btn btn-sm"
                style={{ textDecoration: 'none' }}
              >
                Download Troubleshooting Logs
              </a>
              {authStatus.authEnabled && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void onLogout()}
                >
                  <LogOut size={13} />
                  Sign Out of Web UI
                </button>
              )}
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

        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="panel-header">
            <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <ShieldCheck size={16} />
              HTTPS &amp; TLS Certificates
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className={`chip ${tlsStatus?.active ? 'ok' : ''}`}>
                <Lock size={11} />
                {tlsStatus?.active
                  ? `HTTPS Active (:${tlsStatus.httpsPort ?? tlsCfg?.httpsPort ?? 3443})`
                  : 'HTTPS Inactive'}
              </span>
              {tlsStatus?.certSource && tlsStatus.certSource !== 'none' && (
                <span className="chip accent">
                  {tlsStatus.certSource === 'self-signed'
                    ? 'Auto Self-Signed'
                    : tlsStatus.certSource === 'uploaded-pem'
                      ? 'Custom PEM'
                      : tlsStatus.certSource === 'env-files'
                        ? 'Env Cert Files'
                        : 'Custom File Paths'}
                </span>
              )}
            </div>
          </div>

          <div className="panel-body form-stack">
            {tlsStatus?.lastError && (
              <div
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  fontSize: 12,
                  color: '#fca5a5',
                }}
              >
                TLS Notice: {tlsStatus.lastError}
              </div>
            )}

            {tlsStatus?.subject && (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 10,
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                    Active Certificate Details
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {tlsStatus.active && tlsStatus.httpsPort && (
                      <a
                        href={`https://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${tlsStatus.httpsPort}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm btn-primary"
                        style={{ textDecoration: 'none' }}
                      >
                        <ExternalLink size={12} />
                        Open HTTPS (:{tlsStatus.httpsPort})
                      </a>
                    )}
                    <a
                      href="/api/tls/certificate/download"
                      download="ringwatch-cert.crt"
                      className="btn btn-sm"
                      style={{ textDecoration: 'none' }}
                    >
                      <Download size={12} />
                      Download Cert (.crt)
                    </a>
                    {!tlsStatus.managedByEnv &&
                      tlsStatus.certSource === 'self-signed' &&
                      onRegenerateSelfSignedCert && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={tlsBusy}
                          onClick={async () => {
                            setTlsBusy(true)
                            setTlsMsg(null)
                            try {
                              await onRegenerateSelfSignedCert()
                              setTlsMsg({
                                ok: true,
                                text: 'Generated a fresh 365-day self-signed certificate and reloaded HTTPS live.',
                              })
                            } catch (err) {
                              setTlsMsg({
                                ok: false,
                                text: err instanceof Error ? err.message : String(err),
                              })
                            } finally {
                              setTlsBusy(false)
                            }
                          }}
                        >
                          <RefreshCw size={12} />
                          Regenerate Now
                        </button>
                      )}
                  </div>
                </div>

                <div
                  className="mono"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: 8,
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>Subject</div>
                    <div style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                      {tlsStatus.subject}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>Issuer</div>
                    <div style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                      {tlsStatus.issuer}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>Valid Until</div>
                    <div
                      style={{
                        color:
                          (tlsStatus.daysRemaining ?? 0) > 30 ? '#4ade80' : '#fbbf24',
                        fontWeight: 600,
                      }}
                    >
                      {tlsStatus.validTo
                        ? `${new Date(tlsStatus.validTo).toLocaleDateString()} (${tlsStatus.daysRemaining ?? 0}d left)`
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>Auto-Update</div>
                    <div style={{ color: 'var(--text-primary)' }}>
                      {tlsStatus.certSource === 'self-signed'
                        ? `Auto-renews ${tlsStatus.autoRenewDaysBeforeExpiry}d before expiry & on LAN IP change`
                        : tlsStatus.certSource === 'file-paths' ||
                            tlsStatus.certSource === 'env-files'
                          ? 'Auto-reloads when cert files update on disk'
                          : 'Manual upload (replace anytime)'}
                    </div>
                  </div>
                </div>

                {tlsStatus.subjectAltNames.length > 0 && (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    SANs: {tlsStatus.subjectAltNames.join(', ')}
                  </div>
                )}
                {tlsStatus.fingerprint256 && (
                  <div
                    className="mono"
                    style={{ fontSize: 10.5, color: 'var(--text-muted)', wordBreak: 'break-all' }}
                  >
                    SHA-256: {tlsStatus.fingerprint256}
                  </div>
                )}
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: 12,
              }}
            >
              <div className="toggle-row">
                <div>
                  <div className="toggle-label-main">Enable Built-In HTTPS Server</div>
                  <div className="toggle-label-sub">
                    Serve RingWatch over TLS 1.2/1.3 (required for Passkeys &amp; notifications on LAN hostnames)
                  </div>
                </div>
                <button
                  id="toggle-tls-enabled"
                  type="button"
                  role="switch"
                  aria-checked={tlsCfg?.enabled ?? true}
                  className={`switch ${tlsCfg?.enabled ?? true ? 'on' : ''}`}
                  onClick={() =>
                    void onUpdateSettings({
                      tls: { enabled: !(tlsCfg?.enabled ?? true) },
                    })
                  }
                />
              </div>

              <div className="toggle-row">
                <div>
                  <div className="toggle-label-main">Redirect HTTP → HTTPS</div>
                  <div className="toggle-label-sub">
                    Automatically redirect browser HTTP traffic to HTTPS (exempts local service health checks)
                  </div>
                </div>
                <button
                  id="toggle-tls-redirect"
                  type="button"
                  role="switch"
                  aria-checked={tlsCfg?.redirectHttpToHttps ?? false}
                  className={`switch ${tlsCfg?.redirectHttpToHttps ? 'on' : ''}`}
                  onClick={() =>
                    void onUpdateSettings({
                      tls: { redirectHttpToHttps: !(tlsCfg?.redirectHttpToHttps ?? false) },
                    })
                  }
                />
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 10,
              }}
            >
              <div className="field">
                <label htmlFor="tls-https-port">HTTPS Port</label>
                <input
                  id="tls-https-port"
                  type="number"
                  min={1}
                  max={65535}
                  className="input mono"
                  value={tlsCfg?.httpsPort ?? 3443}
                  onChange={(e) => {
                    const port = Number(e.target.value)
                    if (Number.isFinite(port) && port >= 1 && port <= 65535) {
                      void onUpdateSettings({ tls: { httpsPort: port } })
                    }
                  }}
                />
              </div>

              <div className="field">
                <label htmlFor="tls-renew-days">Self-Signed Auto-Renew (days before expiry)</label>
                <input
                  id="tls-renew-days"
                  type="number"
                  min={1}
                  max={180}
                  className="input mono"
                  value={tlsCfg?.autoRenewDaysBeforeExpiry ?? 30}
                  onChange={(e) => {
                    const days = Number(e.target.value)
                    if (Number.isFinite(days) && days >= 1 && days <= 180) {
                      void onUpdateSettings({
                        tls: { autoRenewDaysBeforeExpiry: days },
                      })
                    }
                  }}
                />
              </div>
            </div>

            {tlsStatus?.managedByEnv ? (
              <div
                style={{
                  padding: '9px 11px',
                  borderRadius: 7,
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                }}
              >
                TLS certificates are managed via{' '}
                <code className="mono">RINGWATCH_TLS_CERT_PATH</code> and{' '}
                <code className="mono">RINGWATCH_TLS_KEY_PATH</code> environment variables
                and automatically hot-reload when updated on disk.
              </div>
            ) : (
              <div className="form-stack" style={{ gap: 10 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${tlsTab === 'self-signed' ? 'btn-primary' : ''}`}
                    onClick={() => setTlsTab('self-signed')}
                  >
                    <RefreshCw size={12} />
                    Auto Self-Signed
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${tlsTab === 'custom-pem' ? 'btn-primary' : ''}`}
                    onClick={() => setTlsTab('custom-pem')}
                  >
                    <Upload size={12} />
                    Upload / Paste Custom Cert (PEM)
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${tlsTab === 'custom-files' ? 'btn-primary' : ''}`}
                    onClick={() => setTlsTab('custom-files')}
                  >
                    <FolderOpen size={12} />
                    Use Cert Files on Disk (Certbot / ACME)
                  </button>
                </div>

                {tlsTab === 'self-signed' && (
                  <div className="form-stack" style={{ gap: 8 }}>
                    <div className="field">
                      <label htmlFor="tls-san-hosts">
                        Extra Hostnames / Domains (SANs, comma-separated, optional)
                      </label>
                      <input
                        id="tls-san-hosts"
                        type="text"
                        className="input mono"
                        placeholder="e.g. ringwatch.home.arpa, nvr.lan (localhost & LAN IPs are included automatically)"
                        value={sanInput}
                        onChange={(e) => setSanInput(e.target.value)}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {onRegenerateSelfSignedCert && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={tlsBusy}
                          onClick={async () => {
                            setTlsBusy(true)
                            setTlsMsg(null)
                            try {
                              const hosts = sanInput
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean)
                              await onRegenerateSelfSignedCert(hosts)
                              setTlsMsg({
                                ok: true,
                                text: 'Self-signed certificate regenerated with updated SANs and reloaded live.',
                              })
                            } catch (err) {
                              setTlsMsg({
                                ok: false,
                                text: err instanceof Error ? err.message : String(err),
                              })
                            } finally {
                              setTlsBusy(false)
                            }
                          }}
                        >
                          <RefreshCw size={13} />
                          {tlsCfg?.mode === 'self-signed'
                            ? 'Save SANs & Regenerate Self-Signed Cert'
                            : 'Switch to Auto Self-Signed Cert'}
                        </button>
                      )}
                      {tlsCfg?.mode !== 'self-signed' && onSwitchToSelfSignedCert && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={tlsBusy}
                          onClick={async () => {
                            setTlsBusy(true)
                            setTlsMsg(null)
                            try {
                              await onSwitchToSelfSignedCert()
                              setTlsMsg({
                                ok: true,
                                text: 'Switched back to the auto-renewing self-signed certificate.',
                              })
                            } catch (err) {
                              setTlsMsg({
                                ok: false,
                                text: err instanceof Error ? err.message : String(err),
                              })
                            } finally {
                              setTlsBusy(false)
                            }
                          }}
                        >
                          Use Existing Self-Signed Cert
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {tlsTab === 'custom-pem' && (
                  <div className="form-stack" style={{ gap: 8 }}>
                    <div className="field">
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                        }}
                      >
                        <label htmlFor="tls-cert-pem">Certificate / Fullchain PEM</label>
                        <label className="btn btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
                          <FileKey2 size={12} />
                          Load .crt / .pem
                          <input
                            type="file"
                            accept=".pem,.crt,.cer,text/plain"
                            style={{ display: 'none' }}
                            onChange={(e) =>
                              void readFileText(e.target.files?.[0], setCertPemInput)
                            }
                          />
                        </label>
                      </div>
                      <textarea
                        id="tls-cert-pem"
                        rows={4}
                        className="input mono"
                        style={{ fontSize: 11, resize: 'vertical' }}
                        placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                        value={certPemInput}
                        onChange={(e) => setCertPemInput(e.target.value)}
                      />
                    </div>

                    <div className="field">
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                        }}
                      >
                        <label htmlFor="tls-key-pem">Private Key PEM</label>
                        <label className="btn btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
                          <KeyRound size={12} />
                          Load .key / .pem
                          <input
                            type="file"
                            accept=".key,.pem,text/plain"
                            style={{ display: 'none' }}
                            onChange={(e) =>
                              void readFileText(e.target.files?.[0], setKeyPemInput)
                            }
                          />
                        </label>
                      </div>
                      <textarea
                        id="tls-key-pem"
                        rows={4}
                        className="input mono"
                        style={{ fontSize: 11, resize: 'vertical' }}
                        placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                        value={keyPemInput}
                        onChange={(e) => setKeyPemInput(e.target.value)}
                      />
                    </div>

                    <div className="field">
                      <label htmlFor="tls-ca-pem">Intermediate / CA Chain PEM (optional)</label>
                      <textarea
                        id="tls-ca-pem"
                        rows={2}
                        className="input mono"
                        style={{ fontSize: 11, resize: 'vertical' }}
                        placeholder="Optional CA bundle if not already included in fullchain"
                        value={caPemInput}
                        onChange={(e) => setCaPemInput(e.target.value)}
                      />
                    </div>

                    {onUploadCustomTlsCert && (
                      <div>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={tlsBusy || !certPemInput.trim() || !keyPemInput.trim()}
                          onClick={async () => {
                            setTlsBusy(true)
                            setTlsMsg(null)
                            try {
                              await onUploadCustomTlsCert({
                                certPem: certPemInput,
                                keyPem: keyPemInput,
                                caPem: caPemInput.trim() || undefined,
                              })
                              setKeyPemInput('')
                              setTlsMsg({
                                ok: true,
                                text: 'Custom certificate validated, saved locally (0600), and hot-reloaded live.',
                              })
                            } catch (err) {
                              setTlsMsg({
                                ok: false,
                                text: err instanceof Error ? err.message : String(err),
                              })
                            } finally {
                              setTlsBusy(false)
                            }
                          }}
                        >
                          <Upload size={13} />
                          Validate &amp; Install Certificate
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {tlsTab === 'custom-files' && (
                  <div className="form-stack" style={{ gap: 8 }}>
                    <div className="field">
                      <label htmlFor="tls-cert-path">Certificate / Fullchain File Path</label>
                      <input
                        id="tls-cert-path"
                        type="text"
                        className="input mono"
                        placeholder="e.g. C:\certs\fullchain.pem or /etc/letsencrypt/live/domain/fullchain.pem"
                        value={certPathInput}
                        onChange={(e) => setCertPathInput(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="tls-key-path">Private Key File Path</label>
                      <input
                        id="tls-key-path"
                        type="text"
                        className="input mono"
                        placeholder="e.g. C:\certs\privkey.pem or /etc/letsencrypt/live/domain/privkey.pem"
                        value={keyPathInput}
                        onChange={(e) => setKeyPathInput(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="tls-ca-path">CA Chain File Path (optional)</label>
                      <input
                        id="tls-ca-path"
                        type="text"
                        className="input mono"
                        placeholder="Optional intermediate/CA chain file path"
                        value={caPathInput}
                        onChange={(e) => setCaPathInput(e.target.value)}
                      />
                    </div>
                    {onUseCustomTlsCertFiles && (
                      <div>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={tlsBusy || !certPathInput.trim() || !keyPathInput.trim()}
                          onClick={async () => {
                            setTlsBusy(true)
                            setTlsMsg(null)
                            try {
                              await onUseCustomTlsCertFiles({
                                certPath: certPathInput,
                                keyPath: keyPathInput,
                                caPath: caPathInput.trim() || undefined,
                              })
                              setTlsMsg({
                                ok: true,
                                text: 'Loaded external certificate files. RingWatch will auto-reload them whenever renewed on disk.',
                              })
                            } catch (err) {
                              setTlsMsg({
                                ok: false,
                                text: err instanceof Error ? err.message : String(err),
                              })
                            } finally {
                              setTlsBusy(false)
                            }
                          }}
                        >
                          <FolderOpen size={13} />
                          Load &amp; Auto-Watch Cert Files
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {tlsMsg && (
                  <div
                    style={{
                      fontSize: 12,
                      color: tlsMsg.ok ? '#4ade80' : '#fca5a5',
                    }}
                  >
                    {tlsMsg.text}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
