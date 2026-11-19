import {
  AlertTriangle,
  BellRing,
  Circle,
  DoorOpen,
  HardDrive,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Zap,
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
    subtitle: 'Real-time HLS video streams, continuous all-camera NVR recording, and instant snapshots',
  },
  nvr: {
    title: '24/7 NVR & Storage Console',
    subtitle: 'Autonomous continuous recording, external USB/HDD/NAS drive pool, failover, and health watchdog',
  },
  timeline: {
    title: 'Video & Event Timeline',
    subtitle: 'Scrub across continuous recordings, camera motion, doorbell rings, AI packages, and sensor events',
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
    subtitle: 'Ring 2FA / Refresh Token auth, continuous NVR rules, Vision keys, and Windows preferences',
  },
}

export function TopBar({
  activeTab,
  connection,
  primaryLocation,
  nvrStatus,
  storageStats,
  cameraCount,
  nvrBusy,
  isRefreshing,
  onToggleAllRecording,
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
          : 'No Alarm'

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
            title="Open NVR & Storage Console to inspect drive status and free space"
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
            id="btn-topbar-nvr-toggle"
            type="button"
            className={`btn btn-sm ${nvrStatus.active ? 'btn-danger' : 'btn-primary'}`}
            disabled={nvrBusy}
            onClick={onToggleAllRecording}
            title={
              nvrStatus.active
                ? `Stop continuous live-stream recording (${nvrStatus.activeCameraCount} camera(s), ${nvrStatus.totalSegmentsCaptured} segments saved)`
                : 'Continuously record live streams from all cameras into local MP4 segments for the Timeline'
            }
          >
            {nvrStatus.active ? (
              <>
                <Square size={12} fill="currentColor" />
                {nvrBusy
                  ? 'Stopping…'
                  : `Stop NVR (${nvrStatus.activeCameraCount}/${cameraCount})`}
              </>
            ) : (
              <>
                <Circle size={11} fill="#ef4444" color="#ef4444" />
                {nvrBusy ? 'Starting…' : 'Record All Cameras'}
              </>
            )}
          </button>
        )}

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
