import { useState, type FormEvent } from 'react'
import { Lock, ShieldCheck } from 'lucide-react'

interface LoginGateProps {
  onLogin: (password: string) => Promise<{ ok: boolean; error?: string }>
}

export function LoginGate({ onLogin }: LoginGateProps) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password.trim()) {
      setError('Enter your RingWatch password.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await onLogin(password)
      if (!res.ok) {
        setError(res.error ?? 'Incorrect password.')
      }
    } finally {
      setSubmitting(false)
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
        style={{ width: '100%', maxWidth: 380, overflow: 'hidden' }}
      >
        <div className="panel-header" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="brand-badge">
              <ShieldCheck size={16} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>RingWatch NVR</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Sign in to access cameras &amp; recordings
              </div>
            </div>
          </div>
          <Lock size={16} style={{ color: 'var(--text-muted)' }} />
        </div>

        <div className="panel-body form-stack">
          <div className="field">
            <label htmlFor="login-password">Admin Password</label>
            <input
              id="login-password"
              type="password"
              className="input"
              autoFocus
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
            className="btn btn-primary"
            disabled={submitting}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </div>
      </form>
    </div>
  )
}
