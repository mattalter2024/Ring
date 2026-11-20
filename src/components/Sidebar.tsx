import {
  Camera,
  Clock,
  Film,
  HardDrive,
  Package,
  Radio,
  Settings,
  Shield,
} from 'lucide-react'
import type { ConnectionStatus, NvrStatus, StorageStats } from '@shared/types'

export type NavTab =
  | 'cameras'
  | 'nvr'
  | 'timeline'
  | 'recordings'
  | 'sensors'
  | 'package-ai'
  | 'settings'

interface SidebarProps {
  activeTab: NavTab
  onSelectTab: (tab: NavTab) => void
  connection: ConnectionStatus
  nvrStatus: NvrStatus
  storageStats: StorageStats
  streamingCount: number
  recordingsCount: number
  faultedSensorCount: number
  detectedPackagesCount: number
}

export function Sidebar({
  activeTab,
  onSelectTab,
  connection,
  nvrStatus,
  storageStats,
  streamingCount,
  recordingsCount,
  faultedSensorCount,
  detectedPackagesCount,
}: SidebarProps) {
  const nvrBadge = storageStats.usingFailover
    ? { text: 'FAILOVER', tone: 'alert' as const }
    : storageStats.diskHealth === 'offline'
      ? { text: 'OFFLINE', tone: 'alert' as const }
      : storageStats.diskHealth === 'critical' || storageStats.diskHealth === 'warning'
        ? { text: 'DISK LOW', tone: 'alert' as const }
        : nvrStatus.active
          ? { text: '24/7', tone: 'live' as const }
          : undefined

  const navItems: Array<{
    id: NavTab
    label: string
    icon: typeof Camera
    badge?: string
    badgeTone?: 'live' | 'alert'
  }> = [
    {
      id: 'cameras',
      label: 'Live Cameras',
      icon: Camera,
      badge: streamingCount > 0 ? `${streamingCount} LIVE` : undefined,
      badgeTone: 'live',
    },
    {
      id: 'timeline',
      label: 'Timeline',
      icon: Clock,
    },
    {
      id: 'recordings',
      label: 'Recordings',
      icon: Film,
      badge: recordingsCount > 0 ? String(recordingsCount) : undefined,
    },
    {
      id: 'nvr',
      label: 'NVR & Storage',
      icon: HardDrive,
      badge: nvrBadge?.text,
      badgeTone: nvrBadge?.tone,
    },
    {
      id: 'package-ai',
      label: 'AI Packages',
      icon: Package,
      badge: detectedPackagesCount > 0 ? String(detectedPackagesCount) : undefined,
      badgeTone: detectedPackagesCount > 0 ? 'alert' : undefined,
    },
    {
      id: 'sensors',
      label: 'Sensors',
      icon: Radio,
      badge: faultedSensorCount > 0 ? `${faultedSensorCount} OPEN` : undefined,
      badgeTone: 'alert',
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
    },
  ]

  const statusDotClass = !connection.connected
    ? 'err'
    : connection.mode === 'demo'
      ? 'warn'
      : 'ok'

  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand-header">
        <div className="brand-mark" aria-hidden="true">
          <Shield size={19} strokeWidth={2.2} />
        </div>
        <div className="brand-text">
          <h2>RingWatch</h2>
          <span>NVR &amp; AI Security Hub</span>
        </div>
      </div>

      <nav className="nav-list">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = activeTab === item.id
          return (
            <button
              key={item.id}
              id={`nav-${item.id}`}
              type="button"
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelectTab(item.id)}
            >
              <Icon size={17} strokeWidth={1.9} />
              <span className="nav-label">{item.label}</span>
              {item.badge && (
                <span className={`nav-badge ${item.badgeTone ?? ''}`}>
                  {item.badge}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="connection-row">
          <span className={`status-dot ${statusDotClass}`} />
          <span>
            {connection.mode === 'demo'
              ? 'Demo Mode'
              : connection.connected
                ? 'Ring Connected'
                : 'Disconnected'}
          </span>
        </div>
        <div className="connection-sub" title={connection.accountLabel ?? connection.error}>
          {connection.accountLabel ?? connection.error ?? 'Configure Ring in Settings'}
        </div>
      </div>
    </aside>
  )
}
