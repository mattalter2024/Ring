import {
  Camera,
  Clock,
  Film,
  Package,
  Radio,
  Settings,
  Shield,
} from 'lucide-react'
import type { ConnectionStatus } from '@shared/types'

export type NavTab =
  | 'cameras'
  | 'timeline'
  | 'recordings'
  | 'sensors'
  | 'package-ai'
  | 'settings'

interface SidebarProps {
  activeTab: NavTab
  onSelectTab: (tab: NavTab) => void
  connection: ConnectionStatus
  streamingCount: number
  recordingsCount: number
  faultedSensorCount: number
  detectedPackagesCount: number
}

export function Sidebar({
  activeTab,
  onSelectTab,
  connection,
  streamingCount,
  recordingsCount,
  faultedSensorCount,
  detectedPackagesCount,
}: SidebarProps) {
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
      label: 'Local Videos',
      icon: Film,
      badge: recordingsCount > 0 ? String(recordingsCount) : undefined,
    },
    {
      id: 'sensors',
      label: 'Sensors & Events',
      icon: Radio,
      badge: faultedSensorCount > 0 ? `${faultedSensorCount} OPEN` : undefined,
      badgeTone: 'alert',
    },
    {
      id: 'package-ai',
      label: 'AI Package Watch',
      icon: Package,
      badge: detectedPackagesCount > 0 ? String(detectedPackagesCount) : undefined,
      badgeTone: detectedPackagesCount > 0 ? 'alert' : undefined,
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
          <span>Windows Security Hub</span>
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
