import { useState } from 'react'
import {
  Activity,
  Battery,
  DoorClosed,
  DoorOpen,
  Droplets,
  Flame,
  KeyRound,
  Lock,
  Radio,
  Shield,
} from 'lucide-react'
import type {
  RingLocationInfo,
  RingSensorInfo,
  SecurityEvent,
} from '@shared/types'
import { formatRelativeTime, formatTimestamp } from '@/utils/format'

interface SensorsViewProps {
  locations: RingLocationInfo[]
  sensors: RingSensorInfo[]
  events: SecurityEvent[]
  onSetAlarmMode: (
    locationId: string,
    mode: 'none' | 'some' | 'all',
  ) => Promise<void>
}

function SensorIcon({ sensor }: { sensor: RingSensorInfo }) {
  switch (sensor.category) {
    case 'contact':
      return sensor.faulted ? (
        <DoorOpen size={17} color="#f59e0b" />
      ) : (
        <DoorClosed size={17} color="#22c55e" />
      )
    case 'motion':
      return <Activity size={17} color={sensor.faulted ? '#f59e0b' : '#5cc7f8'} />
    case 'flood':
      return <Droplets size={17} color={sensor.faulted ? '#ef4444' : '#5cc7f8'} />
    case 'smoke':
      return <Flame size={17} color={sensor.faulted ? '#ef4444' : '#22c55e'} />
    case 'keypad':
      return <KeyRound size={17} color="#9fb0c5" />
    case 'lock':
      return <Lock size={17} color={sensor.faulted ? '#f59e0b' : '#22c55e'} />
    default:
      return <Radio size={17} color="#9fb0c5" />
  }
}

export function SensorsView({
  locations,
  sensors,
  events,
  onSetAlarmMode,
}: SensorsViewProps) {
  const [filter, setFilter] = useState<'all' | SecurityEvent['sourceType']>('all')
  const [updatingLoc, setUpdatingLoc] = useState<string | null>(null)

  const filteredEvents =
    filter === 'all' ? events : events.filter((e) => e.sourceType === filter)

  return (
    <div>
      {locations.map((loc) => (
        <section key={loc.id} className="alarm-banner" aria-label="Alarm mode controls">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Shield size={22} color="#1998d5" />
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{loc.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {loc.hasAlarm
                  ? 'Ring Alarm Base Station connected'
                  : 'Camera-only location'}
              </div>
            </div>
          </div>

          {loc.hasAlarm && (
            <div className="segmented" role="group" aria-label="Ring Alarm mode">
              {(
                [
                  { id: 'none', label: 'Disarmed' },
                  { id: 'some', label: 'Home' },
                  { id: 'all', label: 'Away' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={updatingLoc === loc.id}
                  className={loc.alarmMode === opt.id ? 'active' : ''}
                  onClick={async () => {
                    setUpdatingLoc(loc.id)
                    try {
                      await onSetAlarmMode(loc.id, opt.id)
                    } finally {
                      setUpdatingLoc(null)
                    }
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </section>
      ))}

      <div className="sensors-events-grid">
        <section className="panel">
          <div className="panel-header">
            <h3>Connected Sensors &amp; Devices ({sensors.length})</h3>
            <span className="chip">
              {sensors.filter((s) => s.faulted).length} active alerts
            </span>
          </div>
          <div className="panel-body">
            {sensors.length === 0 ? (
              <div className="empty-state">
                <Radio size={26} />
                <strong>No Ring Alarm sensors detected</strong>
                <span>
                  Sensors connected to a Ring Alarm Base Station or Smart Lighting
                  Bridge appear here automatically.
                </span>
              </div>
            ) : (
              <div className="sensor-cards">
                {sensors.map((sensor) => (
                  <article
                    key={sensor.id}
                    className={`sensor-card ${sensor.faulted ? 'faulted' : ''}`}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <SensorIcon sensor={sensor} />
                      <span
                        className={`chip ${
                          !sensor.online
                            ? 'alert'
                            : sensor.faulted
                              ? 'warn'
                              : 'ok'
                        }`}
                      >
                        {sensor.statusLabel}
                      </span>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                        {sensor.name}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 11, color: 'var(--text-muted)' }}
                      >
                        {sensor.deviceType}
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: 11.5,
                        color: 'var(--text-secondary)',
                        marginTop: 'auto',
                        paddingTop: 4,
                        borderTop: '1px solid var(--border-subtle)',
                      }}
                    >
                      <span className="mono">
                        {sensor.batteryPercent !== null ? (
                          <>
                            <Battery
                              size={12}
                              style={{ verticalAlign: -2, marginRight: 4 }}
                            />
                            {sensor.batteryPercent}%
                          </>
                        ) : (
                          'AC / Hub'
                        )}
                      </span>
                      <span>{formatRelativeTime(sensor.lastUpdatedAt)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Live Event Stream</h3>
            <select
              aria-label="Filter event stream"
              className="select"
              style={{ width: 156, padding: '4px 8px', fontSize: 12 }}
              value={filter}
              onChange={(e) =>
                setFilter(e.target.value as 'all' | SecurityEvent['sourceType'])
              }
            >
              <option value="all">All Sources</option>
              <option value="sensor">Sensors</option>
              <option value="camera">Cameras</option>
              <option value="ai-package">AI Packages</option>
              <option value="alarm">Alarm Modes</option>
              <option value="recording">Recordings</option>
            </select>
          </div>

          <div className="panel-body">
            {filteredEvents.length === 0 ? (
              <div className="empty-state">
                <Activity size={24} />
                <span>No events matching this filter yet.</span>
              </div>
            ) : (
              <div className="event-feed">
                {filteredEvents.map((ev) => (
                  <div key={ev.id} className="event-item">
                    {ev.snapshotDataUrl && (
                      <img
                        src={ev.snapshotDataUrl}
                        alt={ev.deviceName}
                        className="event-thumb"
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                        }}
                      >
                        <strong style={{ fontSize: 13 }}>{ev.title}</strong>
                        <span
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: 'var(--text-muted)',
                            flexShrink: 0,
                          }}
                        >
                          {formatTimestamp(ev.timestamp)}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          marginTop: 2,
                        }}
                      >
                        {ev.detail}
                      </div>
                      <div style={{ marginTop: 5, display: 'flex', gap: 6 }}>
                        <span
                          className={`chip ${
                            ev.severity === 'alert'
                              ? 'alert'
                              : ev.severity === 'warning'
                                ? 'warn'
                                : ev.severity === 'success'
                                  ? 'ok'
                                  : ''
                          }`}
                        >
                          {ev.sourceType}
                        </span>
                        <span
                          style={{ fontSize: 11.5, color: 'var(--text-muted)' }}
                        >
                          {ev.deviceName}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
