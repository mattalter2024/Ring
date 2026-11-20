import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  Fingerprint,
  KeyRound,
  LogOut,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
  Users,
} from 'lucide-react'
import {
  PERMISSION_METADATA,
  ROLE_PRESETS,
  hasPermission,
  resolveUserPermissions,
  type Permission,
  type UserRole,
} from '@shared/rbac'
import type { AuthStatus, PublicUser, RingWatchApi } from '@shared/types'
import { formatRelativeTime } from '@/utils/format'

interface UsersAccessViewProps {
  api: RingWatchApi
  authStatus: AuthStatus
  onRefreshAuth: () => Promise<void>
  onRegisterPasskey: (name: string) => Promise<{ ok: boolean; error?: string }>
  onLogout: () => Promise<void>
  onToast: (title: string, body: string, tone?: 'ok' | 'warn' | 'err' | 'info') => void
}

const PERM_GROUPS = [
  'Cameras',
  'Recordings & NVR',
  'Alarm & Sensors',
  'AI Packages',
  'Administration',
] as const

function roleBadgeLabel(role: UserRole): string {
  if (role === 'custom') return 'Custom'
  return ROLE_PRESETS[role]?.label ?? role
}

export function UsersAccessView({
  api,
  authStatus,
  onRefreshAuth,
  onRegisterPasskey,
  onLogout,
  onToast,
}: UsersAccessViewProps) {
  const canManageUsers = hasPermission(authStatus.permissions, 'users:manage')
  const currentUser = authStatus.currentUser
  const webAuthnSupported =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    window.isSecureContext

  const [users, setUsers] = useState<PublicUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)

  // Passkey registration state
  const [passkeyName, setPasskeyName] = useState(() =>
    typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('mac')
      ? 'Mac Touch ID'
      : 'Windows Hello',
  )
  const [passkeyBusy, setPasskeyBusy] = useState(false)

  // Self password change state
  const [currPw, setCurrPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

  // New user form state
  const [newUsername, setNewUsername] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newRole, setNewRole] = useState<UserRole>(
    authStatus.hasUsers ? 'viewer' : 'admin',
  )
  const [newCustomPerms, setNewCustomPerms] = useState<Permission[]>(
    authStatus.hasUsers ? ROLE_PRESETS.viewer.permissions : ROLE_PRESETS.admin.permissions,
  )
  const [newUserPassword, setNewUserPassword] = useState('')
  const [creatingUser, setCreatingUser] = useState(false)

  // Edit existing user state
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editRole, setEditRole] = useState<UserRole>('viewer')
  const [editPerms, setEditPerms] = useState<Permission[]>([])
  const [editResetPassword, setEditResetPassword] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  const loadUsers = useCallback(async () => {
    if (!canManageUsers) return
    setLoadingUsers(true)
    try {
      const list = await api.listUsers()
      setUsers(list)
    } catch (err) {
      onToast(
        'Failed to load users',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    } finally {
      setLoadingUsers(false)
    }
  }, [api, canManageUsers, onToast])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers, authStatus.hasUsers])

  useEffect(() => {
    if (!authStatus.hasUsers) {
      setNewRole('admin')
      setNewCustomPerms(ROLE_PRESETS.admin.permissions)
    }
  }, [authStatus.hasUsers])

  const handleSelectNewRole = (role: UserRole) => {
    setNewRole(role)
    if (role !== 'custom') {
      setNewCustomPerms(resolveUserPermissions(role))
    }
  }

  const toggleNewPerm = (perm: Permission) => {
    setNewRole('custom')
    setNewCustomPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    )
  }

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUsername.trim()) {
      onToast('Username required', 'Enter a username (letters, numbers, dots, hyphens).', 'warn')
      return
    }
    setCreatingUser(true)
    try {
      const isFirst = !authStatus.hasUsers
      const created = await api.createUser({
        username: newUsername.trim(),
        displayName: newDisplayName.trim() || newUsername.trim(),
        role: isFirst ? 'admin' : newRole,
        customPermissions: newRole === 'custom' ? newCustomPerms : undefined,
        password: newUserPassword.trim() || undefined,
      })
      setNewUsername('')
      setNewDisplayName('')
      setNewUserPassword('')
      setNewRole('viewer')
      setNewCustomPerms(ROLE_PRESETS.viewer.permissions)
      await onRefreshAuth()
      await loadUsers()
      onToast(
        isFirst ? 'Admin Account Created' : 'User Created',
        isFirst
          ? `Signed in as ${created.displayName}. You can now register a Passkey (Touch ID / Windows Hello) and add family or guest users.`
          : `Added ${created.displayName} (@${created.username}) as ${roleBadgeLabel(created.role)}.`,
        'ok',
      )
    } catch (err) {
      onToast(
        'Could not create user',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    } finally {
      setCreatingUser(false)
    }
  }

  const startEditingUser = (user: PublicUser) => {
    setEditingUserId(user.id)
    setEditDisplayName(user.displayName)
    setEditRole(user.role)
    setEditPerms(user.permissions)
    setEditResetPassword('')
  }

  const handleEditRoleSelect = (role: UserRole) => {
    setEditRole(role)
    if (role !== 'custom') {
      setEditPerms(resolveUserPermissions(role))
    }
  }

  const toggleEditPerm = (perm: Permission) => {
    setEditRole('custom')
    setEditPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    )
  }

  const handleSaveEdit = async (userId: string) => {
    setSavingEdit(true)
    try {
      await api.updateUser(userId, {
        displayName: editDisplayName.trim() || undefined,
        role: editRole,
        customPermissions: editRole === 'custom' ? editPerms : undefined,
        password: editResetPassword.trim() || undefined,
      })
      setEditingUserId(null)
      await onRefreshAuth()
      await loadUsers()
      onToast('Permissions Updated', 'Role and permission changes take effect immediately.', 'ok')
    } catch (err) {
      onToast(
        'Update Failed',
        err instanceof Error ? err.message : String(err),
        'err',
      )
    } finally {
      setSavingEdit(false)
    }
  }

  const handleToggleDisable = async (user: PublicUser) => {
    try {
      await api.updateUser(user.id, { disabled: !user.disabled })
      await loadUsers()
      onToast(
        user.disabled ? 'Account Enabled' : 'Account Disabled',
        `${user.displayName} (@${user.username}) is now ${user.disabled ? 'active' : 'disabled'}.`,
        'info',
      )
    } catch (err) {
      onToast('Action Failed', err instanceof Error ? err.message : String(err), 'err')
    }
  }

  const handleDeleteUser = async (user: PublicUser) => {
    if (!window.confirm(`Delete user "${user.displayName}" (@${user.username})?`)) return
    try {
      await api.deleteUser(user.id)
      await onRefreshAuth()
      await loadUsers()
      onToast('User Deleted', `Removed ${user.displayName} (@${user.username}).`, 'info')
    } catch (err) {
      onToast('Delete Failed', err instanceof Error ? err.message : String(err), 'err')
    }
  }

  const handleRegisterPasskeyClick = async () => {
    setPasskeyBusy(true)
    try {
      const res = await onRegisterPasskey(passkeyName.trim() || 'Passkey')
      if (res.ok) {
        await onRefreshAuth()
        await loadUsers()
        onToast('Passkey Registered', 'You can now sign in with Touch ID, Windows Hello, or your security key.', 'ok')
      } else {
        onToast('Passkey Failed', res.error ?? 'Could not register passkey.', 'err')
      }
    } finally {
      setPasskeyBusy(false)
    }
  }

  const handleDeleteMyPasskey = async (credId: string, name: string) => {
    if (!window.confirm(`Remove passkey "${name}"?`)) return
    const res = await api.deleteMyPasskey(credId)
    if (res.ok) {
      await onRefreshAuth()
      await loadUsers()
      onToast('Passkey Removed', `Removed "${name}".`, 'info')
    } else {
      onToast('Could not remove passkey', res.error ?? 'Error', 'err')
    }
  }

  const handleChangeMyPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwBusy(true)
    try {
      const res = await api.changeMyPassword({
        currentPassword: currPw || undefined,
        newPassword: newPw,
      })
      if (res.ok) {
        setCurrPw('')
        setNewPw('')
        await onRefreshAuth()
        onToast(
          'Password Updated',
          newPw.trim() ? 'Your account password has been updated.' : 'Password removed (Passkey-only login enabled).',
          'ok',
        )
      } else {
        onToast('Password Update Failed', res.error ?? 'Error', 'err')
      }
    } finally {
      setPwBusy(false)
    }
  }

  const renderPermissionMatrix = (
    selected: Permission[],
    onToggle: (p: Permission) => void,
  ) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 10,
        marginTop: 6,
      }}
    >
      {PERM_GROUPS.map((group) => {
        const items = PERMISSION_METADATA.filter((m) => m.group === group)
        return (
          <div
            key={group}
            style={{
              padding: 10,
              borderRadius: 8,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--text-muted)',
              }}
            >
              {group}
            </div>
            {items.map((item) => {
              const checked = selected.includes(item.id)
              return (
                <label
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    fontSize: 12.5,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(item.id)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <span style={{ display: 'block', fontWeight: 500 }}>{item.label}</span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>
                      {item.description}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="form-stack" style={{ gap: 16 }}>
      {/* My Account & Passkeys */}
      <section className="panel">
        <div className="panel-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Fingerprint size={16} />
            <h3>My Account &amp; Passkeys</h3>
          </div>
          {currentUser ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="chip ok">
                <ShieldCheck size={11} />
                {currentUser.displayName} (@{currentUser.username}) · {roleBadgeLabel(currentUser.role)}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void onLogout()}
              >
                <LogOut size={13} />
                Sign Out
              </button>
            </div>
          ) : (
            <span className="chip">Open LAN Mode (No Accounts Yet)</span>
          )}
        </div>

        <div className="panel-body form-stack">
          {!currentUser || currentUser.id === '__env_admin__' ? (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                fontSize: 13,
                color: 'var(--text-secondary)',
              }}
            >
              Create your first <strong>Administrator</strong> user below to enable{' '}
              <strong>Passkeys (Touch ID / Windows Hello / Security Keys)</strong> and{' '}
              <strong>Multi-User Role-Based Access Control (RBAC)</strong>.
            </div>
          ) : (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
                  gap: 16,
                }}
              >
                {/* Passkey Registration */}
                <div className="form-stack" style={{ gap: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    Registered Passkeys ({currentUser.passkeys.length})
                  </div>

                  {!webAuthnSupported && (
                    <div
                      style={{
                        padding: '8px 10px',
                        borderRadius: 7,
                        background: 'var(--status-warn-soft)',
                        fontSize: 12,
                        color: 'var(--text-warn)',
                      }}
                    >
                      Passkeys require <code>http://localhost</code> or an <code>https://</code>{' '}
                      URL. Open RingWatch on <code>localhost</code> or via HTTPS to register Touch ID
                      or Windows Hello.
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      className="input"
                      placeholder="Passkey label (e.g. MacBook Touch ID)"
                      value={passkeyName}
                      onChange={(e) => setPasskeyName(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={!webAuthnSupported || passkeyBusy}
                      onClick={() => void handleRegisterPasskeyClick()}
                    >
                      <Fingerprint size={14} />
                      {passkeyBusy ? 'Waiting…' : 'Add Passkey'}
                    </button>
                  </div>

                  {currentUser.passkeys.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      No passkeys yet. Add Touch ID, Windows Hello, or a hardware security key for
                      one-tap passwordless sign-in.
                    </div>
                  ) : (
                    <div className="form-stack" style={{ gap: 6 }}>
                      {currentUser.passkeys.map((pk) => (
                        <div
                          key={pk.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            gap: 10,
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 12.5 }}>{pk.name}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                              {pk.backedUp ? 'Synced Passkey' : 'Device Passkey'} · Added{' '}
                              {formatRelativeTime(pk.createdAt)}
                              {pk.lastUsedAt ? ` · Last used ${formatRelativeTime(pk.lastUsedAt)}` : ''}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-icon btn-danger"
                            title="Remove passkey"
                            onClick={() => void handleDeleteMyPasskey(pk.id, pk.name)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Self Password Update */}
                <form className="form-stack" style={{ gap: 8 }} onSubmit={handleChangeMyPassword}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    My Password{' '}
                    <span className="chip" style={{ marginLeft: 6 }}>
                      {currentUser.hasPassword ? 'Set' : 'Passkey-Only'}
                    </span>
                  </div>
                  {currentUser.hasPassword && (
                    <div className="field">
                      <label htmlFor="my-curr-pw">Current Password</label>
                      <input
                        id="my-curr-pw"
                        type="password"
                        className="input"
                        value={currPw}
                        onChange={(e) => setCurrPw(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="my-new-pw">
                      New Password{' '}
                      {currentUser.passkeys.length > 0 ? '(leave blank for Passkey-only)' : ''}
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        id="my-new-pw"
                        type="password"
                        className="input"
                        placeholder="At least 4 characters"
                        value={newPw}
                        onChange={(e) => setNewPw(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="btn btn-sm"
                        disabled={pwBusy}
                      >
                        <KeyRound size={13} />
                        Update
                      </button>
                    </div>
                  </div>
                </form>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                <strong>Your Effective Permissions ({currentUser.permissions.length}):</strong>{' '}
                {currentUser.permissions.join(', ')}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Multi-User & RBAC Administration */}
      {canManageUsers && (
        <section className="panel">
          <div className="panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Users size={16} />
              <h3>Users &amp; Role-Based Permissions (RBAC)</h3>
            </div>
            <span className="chip">
              {users.length} account{users.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="panel-body form-stack" style={{ gap: 18 }}>
            {/* Create User Form */}
            <form
              onSubmit={handleCreateUser}
              style={{
                padding: 14,
                borderRadius: 10,
                background: 'var(--bg-canvas)',
                border: '1px solid var(--border-subtle)',
              }}
              className="form-stack"
            >
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                {authStatus.hasUsers ? 'Create User Account' : 'Create First Administrator Account'}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 10,
                }}
              >
                <div className="field">
                  <label htmlFor="new-user-handle">Username</label>
                  <input
                    id="new-user-handle"
                    type="text"
                    className="input"
                    placeholder={authStatus.hasUsers ? 'e.g. sarah' : 'e.g. admin'}
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-user-name">Display Name</label>
                  <input
                    id="new-user-name"
                    type="text"
                    className="input"
                    placeholder={authStatus.hasUsers ? 'e.g. Sarah' : 'e.g. Home Admin'}
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-user-pw">Initial Password</label>
                  <input
                    id="new-user-pw"
                    type="password"
                    className="input"
                    placeholder="Min 4 chars (they can add a Passkey after)"
                    value={newUserPassword}
                    onChange={(e) => setNewUserPassword(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-user-role">Role / Permission Preset</label>
                  <select
                    id="new-user-role"
                    className="select"
                    disabled={!authStatus.hasUsers}
                    value={authStatus.hasUsers ? newRole : 'admin'}
                    onChange={(e) => handleSelectNewRole(e.target.value as UserRole)}
                  >
                    <option value="admin">Administrator (Full Access)</option>
                    <option value="operator">Home Operator (Cameras, Clips, Alarm, AI)</option>
                    <option value="viewer">Read-Only Viewer (Cameras, Timeline, Sensors)</option>
                    <option value="guest">Guest (Live Cameras &amp; Package Alerts Only)</option>
                    <option value="custom">Custom Permission Set</option>
                  </select>
                </div>
              </div>

              {authStatus.hasUsers && (
                <details className="advanced-drawer" open={newRole === 'custom'}>
                  <summary>
                    Permission Set ({newCustomPerms.length} permissions selected)
                  </summary>
                  <div className="advanced-drawer-body">
                    {renderPermissionMatrix(newCustomPerms, toggleNewPerm)}
                  </div>
                </details>
              )}

              <div>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={creatingUser}
                >
                  <Plus size={14} />
                  {creatingUser
                    ? 'Creating…'
                    : authStatus.hasUsers
                      ? 'Add User'
                      : 'Create Admin Account & Enable Auth'}
                </button>
              </div>
            </form>

            {/* Existing Users List */}
            {loadingUsers ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Loading users…</div>
            ) : users.length > 0 ? (
              <div className="form-stack" style={{ gap: 10 }}>
                {users.map((u) => {
                  const isEditing = editingUserId === u.id
                  return (
                    <div
                      key={u.id}
                      style={{
                        padding: 12,
                        borderRadius: 10,
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 10,
                        }}
                      >
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: 13.5 }}>{u.displayName}</strong>
                            <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              @{u.username}
                            </span>
                            <span className={`chip ${u.role === 'admin' ? 'ok' : ''}`}>
                              <Shield size={11} />
                              {roleBadgeLabel(u.role)}
                            </span>
                            {u.disabled && <span className="chip alert">Disabled</span>}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                            {u.permissions.length} permissions ·{' '}
                            {u.passkeys.length} passkey{u.passkeys.length === 1 ? '' : 's'} ·{' '}
                            {u.hasPassword ? 'Password set' : 'Passkey-only'}
                            {u.lastLoginAt ? ` · Last sign-in ${formatRelativeTime(u.lastLoginAt)}` : ''}
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              isEditing ? setEditingUserId(null) : startEditingUser(u)
                            }
                          >
                            {isEditing ? 'Cancel' : 'Edit Role & Permissions'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            title={u.disabled ? 'Enable account' : 'Disable account'}
                            onClick={() => void handleToggleDisable(u)}
                          >
                            {u.disabled ? <UserCheck size={13} /> : <UserX size={13} />}
                            {u.disabled ? 'Enable' : 'Disable'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-icon btn-danger"
                            title="Delete user"
                            onClick={() => void handleDeleteUser(u)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {isEditing && (
                        <div
                          className="form-stack"
                          style={{
                            marginTop: 12,
                            paddingTop: 12,
                            borderTop: '1px solid var(--border-subtle)',
                            gap: 10,
                          }}
                        >
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                              gap: 10,
                            }}
                          >
                            <div className="field">
                              <label>Display Name</label>
                              <input
                                type="text"
                                className="input"
                                value={editDisplayName}
                                onChange={(e) => setEditDisplayName(e.target.value)}
                              />
                            </div>
                            <div className="field">
                              <label>Role Preset</label>
                              <select
                                className="select"
                                value={editRole}
                                onChange={(e) => handleEditRoleSelect(e.target.value as UserRole)}
                              >
                                <option value="admin">Administrator (Full Access)</option>
                                <option value="operator">Home Operator</option>
                                <option value="viewer">Read-Only Viewer</option>
                                <option value="guest">Guest (Live Only)</option>
                                <option value="custom">Custom Permission Set</option>
                              </select>
                            </div>
                            <div className="field">
                              <label>Reset Password (optional)</label>
                              <input
                                type="password"
                                className="input"
                                placeholder="Leave blank to keep current"
                                value={editResetPassword}
                                onChange={(e) => setEditResetPassword(e.target.value)}
                              />
                            </div>
                          </div>

                          {renderPermissionMatrix(editPerms, toggleEditPerm)}

                          {u.passkeys.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                Revoke Passkey:
                              </span>
                              {u.passkeys.map((pk) => (
                                <button
                                  key={pk.id}
                                  type="button"
                                  className="btn btn-sm btn-danger"
                                  onClick={async () => {
                                    await api.revokeUserPasskey(u.id, pk.id)
                                    await loadUsers()
                                    onToast('Passkey Revoked', `Revoked "${pk.name}" for @${u.username}.`, 'info')
                                  }}
                                >
                                  <Trash2 size={12} />
                                  {pk.name}
                                </button>
                              ))}
                            </div>
                          )}

                          <div>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={savingEdit}
                              onClick={() => void handleSaveEdit(u.id)}
                            >
                              <CheckCircle2 size={13} />
                              {savingEdit ? 'Saving…' : 'Save Role & Permissions'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        </section>
      )}
    </div>
  )
}
