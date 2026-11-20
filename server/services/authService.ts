import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import {
  ALL_PERMISSIONS,
  resolveUserPermissions,
  sanitizePermissions,
  type Permission,
  type UserRole,
} from '../../shared/rbac'
import type { PasskeySummary, PublicUser } from '../../shared/types'
import { hashPassword, verifyPassword } from './secretCrypto'

interface StoredPasskey {
  id: string
  name: string
  publicKeyBase64Url: string
  counter: number
  deviceType: 'singleDevice' | 'multiDevice'
  backedUp: boolean
  transports?: AuthenticatorTransport[]
  createdAt: string
  lastUsedAt?: string
}

interface StoredUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  customPermissions?: Permission[]
  passwordHash?: string
  passkeys: StoredPasskey[]
  disabled: boolean
  createdAt: string
  lastLoginAt?: string
}

interface PendingChallenge {
  challenge: string
  kind: 'register' | 'authenticate'
  userId?: string
  rpID: string
  expectedOrigin: string
  expiresAtMs: number
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const VALID_ROLES = new Set<UserRole>(['admin', 'operator', 'viewer', 'guest', 'custom'])

function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

function assertValidUsername(username: string): string {
  const clean = normalizeUsername(username)
  if (!/^[a-z0-9._-]{2,32}$/.test(clean)) {
    throw new Error(
      'Username must be 2–32 characters using letters, numbers, dots, underscores, or hyphens.',
    )
  }
  return clean
}

function toPublicPasskey(p: StoredPasskey): PasskeySummary {
  return {
    id: p.id,
    name: p.name,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
  }
}

function toPublicUser(u: StoredUser): PublicUser {
  const permissions = resolveUserPermissions(u.role, u.customPermissions)
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    permissions,
    customPermissions: u.role === 'custom' ? permissions : undefined,
    hasPassword: Boolean(u.passwordHash),
    passkeys: u.passkeys.map(toPublicPasskey),
    disabled: u.disabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  }
}

export class AuthService {
  private readonly storePath: string
  private users: StoredUser[] = []
  private readonly challenges = new Map<string, PendingChallenge>()

  constructor(dataDir: string, legacyAdminPasswordHash?: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.storePath = path.join(dataDir, 'ringwatch-users.json')
    this.users = this.loadFromDisk()

    // One-time migration: promote legacy single admin password into a full 'admin' account
    if (this.users.length === 0 && legacyAdminPasswordHash) {
      this.users.push({
        id: crypto.randomUUID(),
        username: 'admin',
        displayName: 'Administrator',
        role: 'admin',
        passwordHash: legacyAdminPasswordHash,
        passkeys: [],
        disabled: false,
        createdAt: new Date().toISOString(),
      })
      this.persist()
    }
  }

  private loadFromDisk(): StoredUser[] {
    if (!fs.existsSync(this.storePath)) return []
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (u): u is StoredUser =>
          Boolean(u && typeof u === 'object' && typeof u.id === 'string' && typeof u.username === 'string'),
      )
    } catch {
      return []
    }
  }

  private persist(): void {
    const tmp = `${this.storePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.users, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    fs.renameSync(tmp, this.storePath)
    try {
      fs.chmodSync(this.storePath, 0o600)
    } catch {
      // Ignore on Windows NTFS
    }
  }

  private pruneExpiredChallenges(): void {
    const now = Date.now()
    for (const [id, entry] of this.challenges.entries()) {
      if (entry.expiresAtMs <= now) {
        this.challenges.delete(id)
      }
    }
  }

  hasUsers(): boolean {
    return this.users.some((u) => !u.disabled)
  }

  listUsers(): PublicUser[] {
    return this.users.map(toPublicUser)
  }

  getUserById(userId: string): PublicUser | null {
    const found = this.users.find((u) => u.id === userId)
    return found ? toPublicUser(found) : null
  }

  getActiveUserWithPermissions(
    userId: string,
  ): { user: PublicUser; permissions: Permission[] } | null {
    const found = this.users.find((u) => u.id === userId && !u.disabled)
    if (!found) return null
    const pub = toPublicUser(found)
    return { user: pub, permissions: pub.permissions }
  }

  private countActiveAdmins(excludeUserId?: string): number {
    return this.users.filter(
      (u) => !u.disabled && u.role === 'admin' && u.id !== excludeUserId,
    ).length
  }

  createUser(params: {
    username: string
    displayName: string
    role: UserRole
    customPermissions?: Permission[]
    password?: string
  }): PublicUser {
    const username = assertValidUsername(params.username)
    if (this.users.some((u) => u.username === username)) {
      throw new Error(`Username "${username}" already exists.`)
    }
    const role: UserRole = VALID_ROLES.has(params.role) ? params.role : 'viewer'
    if (this.users.length === 0 && role !== 'admin') {
      throw new Error('The first account created must have the Administrator role.')
    }
    const displayName = (params.displayName || username).trim().slice(0, 64)
    const password = params.password?.trim() ?? ''
    if (password && password.length < 4) {
      throw new Error('Password must be at least 4 characters.')
    }
    const customPermissions =
      role === 'custom' ? sanitizePermissions(params.customPermissions) : undefined

    const user: StoredUser = {
      id: crypto.randomUUID(),
      username,
      displayName,
      role,
      customPermissions,
      passwordHash: password ? hashPassword(password) : undefined,
      passkeys: [],
      disabled: false,
      createdAt: new Date().toISOString(),
    }
    this.users.push(user)
    this.persist()
    return toPublicUser(user)
  }

  updateUser(
    userId: string,
    patch: {
      displayName?: string
      role?: UserRole
      customPermissions?: Permission[]
      disabled?: boolean
      password?: string
    },
  ): PublicUser {
    const user = this.users.find((u) => u.id === userId)
    if (!user) throw new Error('User not found.')

    const nextRole =
      patch.role !== undefined && VALID_ROLES.has(patch.role) ? patch.role : user.role
    const nextDisabled =
      patch.disabled !== undefined ? Boolean(patch.disabled) : user.disabled

    if (
      user.role === 'admin' &&
      !user.disabled &&
      (nextRole !== 'admin' || nextDisabled) &&
      this.countActiveAdmins(user.id) === 0
    ) {
      throw new Error('Cannot demote or disable the last active Administrator.')
    }

    if (patch.displayName !== undefined && patch.displayName.trim()) {
      user.displayName = patch.displayName.trim().slice(0, 64)
    }
    user.role = nextRole
    if (nextRole === 'custom') {
      user.customPermissions = sanitizePermissions(
        patch.customPermissions ?? user.customPermissions,
      )
    } else {
      delete user.customPermissions
    }
    user.disabled = nextDisabled

    if (patch.password !== undefined) {
      const trimmed = patch.password.trim()
      if (trimmed) {
        if (trimmed.length < 4) {
          throw new Error('Password must be at least 4 characters.')
        }
        user.passwordHash = hashPassword(trimmed)
      }
    }

    this.persist()
    return toPublicUser(user)
  }

  deleteUser(userId: string): void {
    const idx = this.users.findIndex((u) => u.id === userId)
    if (idx < 0) throw new Error('User not found.')
    const target = this.users[idx]
    if (
      target.role === 'admin' &&
      !target.disabled &&
      this.countActiveAdmins(target.id) === 0 &&
      this.users.length > 1
    ) {
      throw new Error('Cannot delete the last active Administrator while other users exist.')
    }
    this.users.splice(idx, 1)
    this.persist()
  }

  changePassword(
    userId: string,
    currentPassword: string | undefined,
    newPassword: string,
  ): void {
    const user = this.users.find((u) => u.id === userId && !u.disabled)
    if (!user) throw new Error('User not found.')
    if (user.passwordHash && !verifyPassword(currentPassword ?? '', user.passwordHash)) {
      throw new Error('Current password is incorrect.')
    }
    const trimmed = newPassword.trim()
    if (!trimmed) {
      if (user.passkeys.length === 0) {
        throw new Error(
          'Register at least one Passkey before removing your password so you are not locked out.',
        )
      }
      delete user.passwordHash
    } else {
      if (trimmed.length < 4) {
        throw new Error('Password must be at least 4 characters.')
      }
      user.passwordHash = hashPassword(trimmed)
    }
    this.persist()
  }

  authenticateWithPassword(
    password: string,
    username?: string,
  ): PublicUser | null {
    const cleanUser = username ? normalizeUsername(username) : ''
    let candidate: StoredUser | undefined

    if (cleanUser) {
      candidate = this.users.find((u) => u.username === cleanUser && !u.disabled)
    } else {
      // Backwards-compatible convenience: if no username entered and a single admin exists (or 'admin')
      candidate =
        this.users.find((u) => u.username === 'admin' && !u.disabled) ??
        (this.users.filter((u) => !u.disabled).length === 1
          ? this.users.find((u) => !u.disabled)
          : undefined)
    }

    if (!candidate || !candidate.passwordHash) return null
    if (!verifyPassword(password, candidate.passwordHash)) return null

    candidate.lastLoginAt = new Date().toISOString()
    this.persist()
    return toPublicUser(candidate)
  }

  /**
   * Generate FIDO2 / WebAuthn registration options for the currently authenticated user.
   */
  async createPasskeyRegistrationOptions(params: {
    userId: string
    rpID: string
    expectedOrigin: string
  }): Promise<{ challengeId: string; options: Record<string, unknown> }> {
    this.pruneExpiredChallenges()
    const user = this.users.find((u) => u.id === params.userId && !u.disabled)
    if (!user) throw new Error('User not found.')

    const options = await generateRegistrationOptions({
      rpName: 'RingWatch Security Hub',
      rpID: params.rpID,
      userName: user.username,
      userDisplayName: user.displayName,
      userID: Buffer.from(user.id, 'utf-8'),
      attestationType: 'none',
      excludeCredentials: user.passkeys.map((pk) => ({
        id: pk.id,
        transports: pk.transports,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    })

    const challengeId = crypto.randomUUID()
    this.challenges.set(challengeId, {
      challenge: options.challenge,
      kind: 'register',
      userId: user.id,
      rpID: params.rpID,
      expectedOrigin: params.expectedOrigin,
      expiresAtMs: Date.now() + CHALLENGE_TTL_MS,
    })

    return {
      challengeId,
      options: options as unknown as Record<string, unknown>,
    }
  }

  /**
   * Verify FIDO2 / WebAuthn attestation response and attach the verified Passkey to the user.
   */
  async verifyPasskeyRegistration(params: {
    userId: string
    challengeId: string
    name: string
    response: RegistrationResponseJSON
  }): Promise<PasskeySummary> {
    this.pruneExpiredChallenges()
    const pending = this.challenges.get(params.challengeId)
    this.challenges.delete(params.challengeId)
    if (!pending || pending.kind !== 'register' || pending.userId !== params.userId) {
      throw new Error('Passkey registration challenge expired or invalid. Please try again.')
    }

    const user = this.users.find((u) => u.id === params.userId && !u.disabled)
    if (!user) throw new Error('User not found.')

    const verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.expectedOrigin,
      expectedRPID: pending.rpID,
      requireUserVerification: false,
    })

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('Passkey verification failed.')
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo

    if (this.findUserByPasskeyId(credential.id)) {
      throw new Error('This passkey is already registered.')
    }

    const stored: StoredPasskey = {
      id: credential.id,
      name: (params.name || 'Passkey').trim().slice(0, 60) || 'Passkey',
      publicKeyBase64Url: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports as AuthenticatorTransport[] | undefined,
      createdAt: new Date().toISOString(),
    }

    user.passkeys.push(stored)
    this.persist()
    return toPublicPasskey(stored)
  }

  /**
   * Generate FIDO2 / WebAuthn authentication options (supports both username-targeted and
   * discoverable one-tap Passkey sign-in without entering a username).
   */
  async createPasskeyAuthenticationOptions(params: {
    username?: string
    rpID: string
    expectedOrigin: string
  }): Promise<{ challengeId: string; options: Record<string, unknown> }> {
    this.pruneExpiredChallenges()
    let allowCredentials:
      | Array<{ id: string; transports?: AuthenticatorTransport[] }>
      | undefined
    let targetUserId: string | undefined

    if (params.username && params.username.trim()) {
      const clean = normalizeUsername(params.username)
      const user = this.users.find((u) => u.username === clean && !u.disabled)
      if (!user || user.passkeys.length === 0) {
        throw new Error('No passkeys registered for that username.')
      }
      targetUserId = user.id
      allowCredentials = user.passkeys.map((pk) => ({
        id: pk.id,
        transports: pk.transports,
      }))
    } else {
      const allPasskeys = this.users
        .filter((u) => !u.disabled)
        .flatMap((u) => u.passkeys)
      if (allPasskeys.length === 0) {
        throw new Error('No passkeys are registered yet. Sign in with password first and add a Passkey.')
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: params.rpID,
      userVerification: 'preferred',
      allowCredentials,
    })

    const challengeId = crypto.randomUUID()
    this.challenges.set(challengeId, {
      challenge: options.challenge,
      kind: 'authenticate',
      userId: targetUserId,
      rpID: params.rpID,
      expectedOrigin: params.expectedOrigin,
      expiresAtMs: Date.now() + CHALLENGE_TTL_MS,
    })

    return {
      challengeId,
      options: options as unknown as Record<string, unknown>,
    }
  }

  /**
   * Verify FIDO2 / WebAuthn assertion response and return the authenticated user.
   */
  async verifyPasskeyAuthentication(params: {
    challengeId: string
    response: AuthenticationResponseJSON
  }): Promise<PublicUser> {
    this.pruneExpiredChallenges()
    const pending = this.challenges.get(params.challengeId)
    this.challenges.delete(params.challengeId)
    if (!pending || pending.kind !== 'authenticate') {
      throw new Error('Passkey sign-in challenge expired or invalid. Please try again.')
    }

    const match = this.findUserByPasskeyId(params.response.id)
    if (!match || match.user.disabled) {
      throw new Error('Unknown or disabled passkey.')
    }
    if (pending.userId && pending.userId !== match.user.id) {
      throw new Error('Passkey does not match the requested account.')
    }

    const verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.expectedOrigin,
      expectedRPID: pending.rpID,
      requireUserVerification: false,
      credential: {
        id: match.passkey.id,
        publicKey: new Uint8Array(
          Buffer.from(match.passkey.publicKeyBase64Url, 'base64url'),
        ),
        counter: match.passkey.counter,
        transports: match.passkey.transports,
      },
    })

    if (!verification.verified) {
      throw new Error('Passkey signature verification failed.')
    }

    match.passkey.counter = verification.authenticationInfo.newCounter
    match.passkey.lastUsedAt = new Date().toISOString()
    match.user.lastLoginAt = match.passkey.lastUsedAt
    this.persist()
    return toPublicUser(match.user)
  }

  removePasskey(userId: string, credentialId: string, allowEmptyAuth = false): void {
    const user = this.users.find((u) => u.id === userId)
    if (!user) throw new Error('User not found.')
    const idx = user.passkeys.findIndex((p) => p.id === credentialId)
    if (idx < 0) throw new Error('Passkey not found.')
    if (!allowEmptyAuth && !user.passwordHash && user.passkeys.length <= 1) {
      throw new Error(
        'Cannot remove your only Passkey while no password is set. Set a password first.',
      )
    }
    user.passkeys.splice(idx, 1)
    this.persist()
  }

  private findUserByPasskeyId(
    credentialId: string,
  ): { user: StoredUser; passkey: StoredPasskey } | null {
    for (const user of this.users) {
      const pk = user.passkeys.find((p) => p.id === credentialId)
      if (pk) return { user, passkey: pk }
    }
    return null
  }

  /**
   * Synthetic virtual admin user representation for open LAN mode (0 users configured)
   * or RINGWATCH_AUTH_PASSWORD environment-variable override.
   */
  getEnvOrOpenAdminContext(managedByEnv: boolean): {
    user: PublicUser | null
    permissions: Permission[]
  } {
    if (managedByEnv) {
      return {
        user: {
          id: '__env_admin__',
          username: 'admin',
          displayName: 'Admin (Env)',
          role: 'admin',
          permissions: [...ALL_PERMISSIONS],
          hasPassword: true,
          passkeys: [],
          disabled: false,
          createdAt: new Date(0).toISOString(),
        },
        permissions: [...ALL_PERMISSIONS],
      }
    }
    return {
      user: null,
      permissions: [...ALL_PERMISSIONS],
    }
  }
}
