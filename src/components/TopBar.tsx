import {
  BellRing,
  DoorOpen,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import type { ConnectionStatus, RingLocationInfo } from '@shared/types'
import type { NavTab } from './Sidebar'

interface TopBarProps {
  activeTab: NavTab
  connection: ConnectionStatus
  primaryLocation?: RingLocationInfo
  isRefreshing: boolean
  onRefresh: () => void
  onSimulateDemoEvent: (
    kind: 'doorbell' | 'motion' | 'contact-open' | 'package-delivery',
  ) => void
}

const TAB_COPY: Record<NavTab, { title: string; subtitle: string }> = {
  cameras: {
    title: 'Live Cameras',
    subtitle: 'Real-time HLS video streams, instant snapshots, and local MP4 capture',
  },
  timeline: {
    title: 'Video & Event Timeline',
    subtitle: 'Scrub across local recordings, camera motion, doorbell rings, AI packages, and sensor events',
  },
  recordings: {
    title: 'Local Video Storage & Cloud Vault',
    subtitle: 'Manage local MP4 storage, disk quotas, retention rules, exports, and Ring Cloud downloads',
  },
  sensors: {
    title: 'Sensors & Event Stream',
    subtitle: 'Ring Alarm modes, door/window contacts, motion sensors, and live activity feed',
  },
  'package-ai': {
    title: 'AI Package Automation',
    subtitle: 'Cloud Vision package detection rules, Windows toast alerts, and sound chimes',
  },
  settings: {
    title: 'Settings & Connections',
    subtitle: 'Ring 2FA / Refresh Token auth, OpenAI & Gemini Vision keys, and Windows preferences',
  },
}

export function TopBar({
  activeTab,
  connection,
  primaryLocation,
  isRefreshing,
  onRefresh,
  onSimulateDemoEvent,
}: TopBarProps) {
  const copy = TAB_COPY[activeTab]

  const alarmLabel =
    primaryLocation?.alarmMode === 'all'
      ? 'Armed Away'
      : primaryLocation?.alarmMode === 'some'
        ? 'Armed Home'
        : primaryLocation?.alarmMode === 'none'
          ? 'Disarmed'
          : 'No Alarm'

  return (
    <header className="topbar">
      <div className="topbar-title-group">
        <h1>{copy.title}</h1>
        <span className="topbar-subtitle">{copy.subtitle}</span>
      </div>

      <div className="topbar-actions">
        {connection.mode === 'demo' && (
          <>
            <button
              id="btn-sim-package"
              type="button"
              className="btn btn-warn btn-sm"
              onClick={() => onSimulateDemoEvent('package-delivery')}
              title="Simulate delivery motion + run AI package detection"
            >
              <PackageCheck size={14} />
              Simulate Package
            </button>
            <button
              id="btn-sim-doorbell"
              type="button"
              className="btn btn-sm"
              onClick={() => onSimulateDemoEvent('doorbell')}
              title="Simulate front doorbell press"
            >
              <BellRing size={14} />
              Ring Bell
            </button>
            <button
              id="btn-sim-contact"
              type="button"
              className="btn btn-sm"
              onClick={() => onSimulateDemoEvent('contact-open')}
              title="Toggle Front Door contact sensor"
            >
              <DoorOpen size={14} />
              Toggle Door
            </button>
          </>
        )}

        {primaryLocation?.hasAlarm && (
          <span
            className={`chip ${
              primaryLocation.alarmMode === 'none' ? '' : 'ok'
            }`}
          >
            {primaryLocation.alarmMode === 'none' ? (
              <ShieldAlert size={13} />
            ) : (
              <ShieldCheck size={13} />
            )}
            {alarmLabel}
          </span>
        )}

        {connection.mode === 'live' && (
          <span className="chip accent">
            <Zap size={12} />
            Live Ring API
          </span>
        )}

        <button
          id="btn-refresh-devices"
          type="button"
          className="btn btn-sm"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw size={14} />
          {isRefreshing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
    </header>
  )
}
