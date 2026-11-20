export const ALL_PERMISSIONS = [
  'cameras:view',
  'cameras:control',
  'recordings:view',
  'recordings:manage',
  'nvr:manage',
  'sensors:view',
  'sensors:arm',
  'ai:view',
  'ai:manage',
  'settings:manage',
  'users:manage',
] as const

export type Permission = (typeof ALL_PERMISSIONS)[number]

export type UserRole = 'admin' | 'operator' | 'viewer' | 'guest' | 'custom'

export interface PermissionMeta {
  id: Permission
  group: 'Cameras' | 'Recordings & NVR' | 'Alarm & Sensors' | 'AI Packages' | 'Administration'
  label: string
  description: string
}

export const PERMISSION_METADATA: PermissionMeta[] = [
  {
    id: 'cameras:view',
    group: 'Cameras',
    label: 'View Live Cameras',
    description: 'Watch live streams and refresh camera snapshots',
  },
  {
    id: 'cameras:control',
    group: 'Cameras',
    label: 'Control Lights & Sirens',
    description: 'Toggle camera floodlights and sound camera sirens',
  },
  {
    id: 'recordings:view',
    group: 'Recordings & NVR',
    label: 'View Timeline & Clips',
    description: 'Scrub 24/7 timeline playback and download recordings',
  },
  {
    id: 'recordings:manage',
    group: 'Recordings & NVR',
    label: 'Manage Recordings',
    description: 'Capture clips, star/protect, delete clips, and export evidence bundles',
  },
  {
    id: 'nvr:manage',
    group: 'Recordings & NVR',
    label: 'Manage 24/7 NVR & Storage',
    description: 'Start/stop continuous NVR recording, configure drives, failover, and pruning',
  },
  {
    id: 'sensors:view',
    group: 'Alarm & Sensors',
    label: 'View Sensors & Events',
    description: 'Monitor door/window sensors and security event history',
  },
  {
    id: 'sensors:arm',
    group: 'Alarm & Sensors',
    label: 'Arm & Disarm Alarm',
    description: 'Switch Ring Alarm between Disarmed, Home, and Away modes',
  },
  {
    id: 'ai:view',
    group: 'AI Packages',
    label: 'View Package Alerts',
    description: 'View AI package detection history and receive delivery alerts',
  },
  {
    id: 'ai:manage',
    group: 'AI Packages',
    label: 'Run & Configure AI Detection',
    description: 'Trigger manual AI scans, clear history, and edit detection rules',
  },
  {
    id: 'settings:manage',
    group: 'Administration',
    label: 'System & Ring Settings',
    description: 'Connect Ring account, manage API keys, and download diagnostic logs',
  },
  {
    id: 'users:manage',
    group: 'Administration',
    label: 'Users, Passkeys & Roles',
    description: 'Create/edit/delete users, assign RBAC roles, and revoke passkeys',
  },
]

export interface RolePresetDefinition {
  id: Exclude<UserRole, 'custom'>
  label: string
  description: string
  permissions: Permission[]
}

export const ROLE_PRESETS: Record<Exclude<UserRole, 'custom'>, RolePresetDefinition> = {
  admin: {
    id: 'admin',
    label: 'Administrator',
    description: 'Full access to cameras, NVR storage, alarm, AI, settings, and user/RBAC management.',
    permissions: [...ALL_PERMISSIONS],
  },
  operator: {
    id: 'operator',
    label: 'Home Operator',
    description: 'Daily home control: live view, lights/sirens, timeline, clips, alarm arm/disarm, and AI scans.',
    permissions: [
      'cameras:view',
      'cameras:control',
      'recordings:view',
      'recordings:manage',
      'sensors:view',
      'sensors:arm',
      'ai:view',
      'ai:manage',
    ],
  },
  viewer: {
    id: 'viewer',
    label: 'Read-Only Viewer',
    description: 'Watch live cameras, scrub timeline/recordings, view sensors, and see package alerts.',
    permissions: ['cameras:view', 'recordings:view', 'sensors:view', 'ai:view'],
  },
  guest: {
    id: 'guest',
    label: 'Guest (Live Only)',
    description: 'Live camera viewing and package alerts only — no recorded history, alarm, or settings.',
    permissions: ['cameras:view', 'ai:view'],
  },
}

const VALID_PERMISSIONS = new Set<string>(ALL_PERMISSIONS)

export function sanitizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return []
  const unique = new Set<Permission>()
  for (const item of input) {
    if (typeof item === 'string' && VALID_PERMISSIONS.has(item)) {
      unique.add(item as Permission)
    }
  }
  return Array.from(unique)
}

export function resolveUserPermissions(
  role: UserRole,
  customPermissions?: Permission[],
): Permission[] {
  if (role === 'admin') return [...ALL_PERMISSIONS]
  if (role === 'custom') return sanitizePermissions(customPermissions)
  const preset = ROLE_PRESETS[role]
  return preset ? [...preset.permissions] : []
}

export function hasPermission(
  permissions: readonly Permission[] | undefined,
  required: Permission,
): boolean {
  if (!permissions || permissions.length === 0) return false
  return permissions.includes(required)
}

export function hasAnyPermission(
  permissions: readonly Permission[] | undefined,
  candidates: readonly Permission[],
): boolean {
  if (!permissions || permissions.length === 0) return false
  return candidates.some((p) => permissions.includes(p))
}
