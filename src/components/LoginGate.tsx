import { useState, type FormEvent } from 'react'
import { Fingerprint, Lock, ShieldCheck } from 'lucide-react'

interface LoginGateProps {
  hasUsers: boolean
  onLogin: (
    password: string,
    username?: string,
  ) => Promise<{ ok: boolean; error?: string }>
  onPasskeyLogin: (username?: string) => Promise<{ ok: boolean; error?: string }>
}

export function LoginGate({
  hasUsers,
  onLogin,
  onPasskeyLogin,
}: LoginGateProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const webAuthnSupported =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    window.isSecureContext

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password.trim()) {
      setError('Enter your password.')
      return
    }
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
        onSubmit={handleSubmit}
        style={{ width: '100%', maxWidth: 400, overflow: 'hidden' }}
      >
        <div className="panel-header" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="brand-badge">
              <ShieldCheck size={16} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>RingWatch Security Hub</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Sign in with Passkey or account credentials
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
                  : 'Sign in with Passkey (Touch ID / Windows Hello)'}
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

          {hasUsers && (
            <div className="field">
              <label htmlFor="login-username">Username</label>
              <input
                id="login-username"
                type="text"
                className="input"
                autoFocus
                autoComplete="username webauthn"
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
