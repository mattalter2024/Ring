import { useEffect, useState, type FormEvent } from 'react'
import { Fingerprint, Lock, ShieldCheck } from 'lucide-react'
import { browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser'

interface LoginGateProps {
  hasUsers: boolean
  hasPasskeys?: boolean
  onLogin: (
    password: string,
    username?: string,
  ) => Promise<{ ok: boolean; error?: string }>
  onPasskeyLogin: (
    username?: string,
    options?: { useBrowserAutofill?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>
  onCancelConditionalPasskey?: () => void
}

function isIpHostname(hostname: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[')
}

export function LoginGate({
  hasUsers,
  hasPasskeys = false,
  onLogin,
  onPasskeyLogin,
  onCancelConditionalPasskey,
}: LoginGateProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const isIpHost = isIpHostname(hostname)
  const isLoopbackIp = hostname === '127.0.0.1' || hostname === '[::1]'
  const localhostSwitchUrl =
    typeof window !== 'undefined' && isLoopbackIp
      ? `${window.location.protocol}//localhost${window.location.port ? `:${window.location.port}` : ''}${window.location.pathname}`
      : null

  const webAuthnSupported =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    window.isSecureContext &&
    !isIpHost

  // Start WebAuthn Conditional UI (Passkey autofill dropdown in the Username field)
  // so Touch ID, iCloud Keychain, 1Password, Bitwarden, and Chrome Password Manager
  // offer one-tap passkey sign-in directly inside the input box.
  useEffect(() => {
    if (!hasUsers || !hasPasskeys || !webAuthnSupported) return
    let active = true
    void browserSupportsWebAuthnAutofill()
      .then((supported) => {
        if (!active || !supported) return
        void onPasskeyLogin(undefined, { useBrowserAutofill: true })
      })
      .catch(() => {
        // Browser does not support conditional mediation; explicit button still works
      })
    return () => {
      active = false
      onCancelConditionalPasskey?.()
    }
  }, [hasUsers, hasPasskeys, webAuthnSupported, onPasskeyLogin, onCancelConditionalPasskey])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password.trim()) {
      setError('Enter your password.')
      return
    }
    onCancelConditionalPasskey?.()
    setSubmitting(true)
    setError(null)
    try {
      const res = await onLogin(password, username.trim() || undefined)
      if (!res.ok) {
        setError(res.error ?? 'Invalid username or password.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handlePasskey = async () => {
    onCancelConditionalPasskey?.()
    setPasskeyBusy(true)
    setError(null)
    try {
      const res = await onPasskeyLogin(username.trim() || undefined)
      if (!res.ok) {
        setError(res.error ?? 'Passkey sign-in cancelled or failed.')
      }
    } finally {
      setPasskeyBusy(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-canvas)',
        padding: 20,
      }}
    >
      <form
        className="panel"
        method="post"
        action="/api/auth/login"
        autoComplete="on"
        onSubmit={handleSubmit}
        style={{ width: '100%', maxWidth: 420, overflow: 'hidden' }}
      >
        <div className="panel-header" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="brand-badge">
              <ShieldCheck size={16} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>RingWatch Security Hub</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Sign in with Passkey (Touch ID / 1Password / Windows Hello) or password
              </div>
            </div>
          </div>
          <Lock size={16} style={{ color: 'var(--text-muted)' }} />
        </div>

        <div className="panel-body form-stack">
          {hasUsers && webAuthnSupported && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={passkeyBusy || submitting}
                onClick={() => void handlePasskey()}
                style={{ width: '100%', justifyContent: 'center', padding: '10px 14px' }}
              >
                <Fingerprint size={16} />
                {passkeyBusy
                  ? 'Waiting for Passkey…'
                  : 'Sign in with Passkey (Touch ID / 1Password / Windows Hello)'}
              </button>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: 'var(--text-muted)',
                  fontSize: 11.5,
                }}
              >
                <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                <span>or sign in with password</span>
                <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
              </div>
            </>
          )}

          {hasUsers && localhostSwitchUrl && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 7,
                background: 'var(--status-warn-soft)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                fontSize: 12,
                color: 'var(--text-primary)',
              }}
            >
              Passkeys require <code>localhost</code> instead of <code>127.0.0.1</code>.{' '}
              <a
                href={localhostSwitchUrl}
                style={{ color: 'var(--accent-text)', fontWeight: 600 }}
              >
                Switch to localhost
              </a>{' '}
              to use Touch ID, 1Password, or Windows Hello.
            </div>
          )}

          {hasUsers && !webAuthnSupported && !localhostSwitchUrl && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 7,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                fontSize: 11.5,
                color: 'var(--text-muted)',
              }}
            >
              Passkeys require <code>localhost</code> or an <code>https://</code> hostname. You can
              sign in below with your password (1Password / Bitwarden password autofill supported).
            </div>
          )}

          {hasUsers && (
            <div className="field">
              <label htmlFor="login-username">Username</label>
              <input
                id="login-username"
                name="username"
                type="text"
                className="input"
                autoFocus
                autoComplete="username webauthn"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="e.g. admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              className="input"
              autoFocus={!hasUsers}
              autoComplete="current-password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 7,
                background: 'var(--status-alert-soft)',
                color: '#fecaca',
                fontSize: 12.5,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            className={`btn ${hasUsers && webAuthnSupported ? '' : 'btn-primary'}`}
            disabled={submitting || passkeyBusy}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {submitting ? 'Signing in…' : 'Sign In with Password'}
          </button>
        </div>
      </form>
    </div>
  )
}
