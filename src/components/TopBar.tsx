import {
  AlertTriangle,
  Circle,
  HardDrive,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import type {
  ConnectionStatus,
  NvrStatus,
  RingLocationInfo,
  StorageStats,
} from '@shared/types'
import type { NavTab } from './Sidebar'

interface TopBarProps {
  activeTab: NavTab
  connection: ConnectionStatus
  primaryLocation?: RingLocationInfo
  nvrStatus: NvrStatus
  storageStats: StorageStats
  cameraCount: number
  nvrBusy: boolean
  isRefreshing: boolean
  onToggleAllRecording: () => void
  onOpenNvr: () => void
  onRefresh: () => void
  onSimulateDemoEvent: (
    kind: 'doorbell' | 'motion' | 'contact-open' | 'package-delivery',
  ) => void
}

const TAB_COPY: Record<NavTab, { title: string; subtitle: string }> = {
  cameras: {
    title: 'Live Cameras',
    subtitle: 'Live camera wall and quick controls',
  },
  timeline: {
    title: 'Timeline',
    subtitle: 'Scrub recordings and security events',
  },
  recordings: {
    title: 'Recordings',
    subtitle: 'Saved MP4 clips and Ring Cloud events',
  },
  nvr: {
    title: 'NVR & Storage',
    subtitle: '24/7 recording, drives, and retention',
  },
  'package-ai': {
    title: 'AI Packages',
    subtitle: 'Automatic box detection and alerts',
  },
  sensors: {
    title: 'Sensors',
    subtitle: 'Ring Alarm mode, sensors, and activity',
  },
  access: {
    title: 'Access & Passkeys',
    subtitle: 'Passkey sign-in, user accounts, and RBAC permission sets',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Ring account, Vision AI, and app preferences',
  },
}

export function TopBar({
  activeTab,
  connection,
  primaryLocation,
  nvrStatus,
  storageStats,
  cameraCount,
  isRefreshing,
  onOpenNvr,
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
          : null

  const showStorageAlert =
    storageStats.usingFailover || storageStats.diskHealth !== 'healthy'

  const storageAlertLabel = storageStats.usingFailover
    ? 'Failover Active'
    : storageStats.diskHealth === 'offline'
      ? 'Drive Offline'
      : storageStats.diskHealth === 'critical'
        ? 'Critical Disk'
        : 'Low Disk'

  return (
    <header className="topbar">
      <div className="topbar-title-group">
        <h1>{copy.title}</h1>
        <span className="topbar-subtitle">{copy.subtitle}</span>
      </div>

      <div className="topbar-actions">
        {showStorageAlert && (
          <button
            id="btn-topbar-storage-alert"
            type="button"
            className={`btn btn-sm ${
              storageStats.usingFailover ||
              storageStats.diskHealth === 'critical' ||
              storageStats.diskHealth === 'offline'
                ? 'btn-danger'
                : 'btn-warn'
            }`}
            onClick={onOpenNvr}
            title="Open NVR & Storage to inspect drive status"
          >
            {storageStats.usingFailover ? (
              <HardDrive size={13} />
            ) : (
              <AlertTriangle size={13} />
            )}
            {storageAlertLabel}
          </button>
        )}

        {cameraCount > 0 && (
          <button
            id="btn-topbar-nvr-status"
            type="button"
            className="btn btn-sm"
            onClick={onOpenNvr}
            title="Open NVR & Storage to manage 24/7 recording"
          >
            <Circle
              size={8}
              fill={nvrStatus.active ? '#ef4444' : 'currentColor'}
              color={nvrStatus.active ? '#ef4444' : 'currentColor'}
            />
            {nvrStatus.active
              ? `24/7 NVR (${nvrStatus.activeCameraCount}/${cameraCount})`
              : 'NVR Standby'}
          </button>
        )}

        {connection.mode === 'demo' && (
          <button
            id="btn-sim-package"
            type="button"
            className="btn btn-warn btn-sm"
            onClick={() => onSimulateDemoEvent('package-delivery')}
            title="Simulate a package delivery event in Demo Mode"
          >
            <PackageCheck size={14} />
            Test Delivery
          </button>
        )}

        {primaryLocation?.hasAlarm && alarmLabel && (
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

        <button
          id="btn-refresh-devices"
          type="button"
          className="btn btn-icon"
          onClick={onRefresh}
          disabled={isRefreshing}
          title="Refresh Ring devices"
        >
          <RefreshCw size={14} className={isRefreshing ? 'spin' : ''} />
        </button>
      </div>
    </header>
  )
}
