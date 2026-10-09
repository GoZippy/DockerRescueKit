import React, { useMemo } from 'react'
import { Globe, Info } from 'lucide-react'
import { getBrowserTimeZone, isValidTimeZone, listTimeZones } from '../utils/schedule'

interface Props {
  /** The zone the schedule will be evaluated in. */
  value: string
  onChange: (timezone: string) => void
  /** Editing a policy that predates time zones: it has been running in UTC. */
  legacy?: boolean
}

/**
 * Time-zone picker for a policy's schedule. Free text with the browser's
 * zone list as suggestions, plus a one-click "Use my timezone".
 */
export const TimezoneField: React.FC<Props> = ({ value, onChange, legacy }) => {
  const browserZone = useMemo(() => getBrowserTimeZone(), [])
  const zones = useMemo(() => listTimeZones(), [])
  const valid = isValidTimeZone(value)
  const isMine = value === browserZone

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label
        htmlFor="policy-timezone"
        style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        Time zone
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Globe size={13} color="var(--text-muted)" style={{ position: 'absolute', left: 10, top: 10 }} />
          <input
            id="policy-timezone"
            list="policy-timezone-options"
            type="text"
            value={value}
            onChange={e => onChange(e.target.value.trim())}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!valid}
            style={{
              width: '100%', padding: '8px 12px 8px 30px', borderRadius: 'var(--r-sm)',
              background: 'var(--surface-1)', color: 'var(--text-primary)', fontSize: 13,
              border: `1px solid ${valid ? 'var(--surface-4)' : 'var(--rose, #f43f5e)'}`,
              boxSizing: 'border-box',
            }}
          />
          <datalist id="policy-timezone-options">
            {zones.map(z => <option key={z} value={z} />)}
          </datalist>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onChange(browserZone)}
          disabled={isMine}
          title={`Run this schedule in your browser's time zone (${browserZone})`}
          style={{ whiteSpace: 'nowrap' }}
        >
          Use my timezone
        </button>
      </div>
      {!valid && (
        <span style={{ fontSize: 11, color: 'var(--rose, #f43f5e)' }}>
          Enter a time zone name like America/Chicago or UTC.
        </span>
      )}
      {legacy && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px', background: 'var(--surface-1)', borderRadius: 'var(--r-sm)', fontSize: 12 }}>
          <Info size={13} color="var(--blue-400, #60a5fa)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
            This policy was created before time zones were supported, so it has always run in UTC.
            It is shown as UTC until you pick a zone. Choosing yours moves its run time to your local clock.
          </span>
        </div>
      )}
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Every time in the schedule below is in {valid ? value : 'this zone'}, and follows daylight saving.
      </span>
    </div>
  )
}
