import React, { useState, useEffect } from 'react'
import { Info } from 'lucide-react'

interface Props {
  value: string
  onChange: (cron: string) => void
  label?: string
}

const PRESETS = [
  { label: 'Every hour',            cron: '0 * * * *',   desc: 'Runs at the top of every hour' },
  { label: 'Every 6 hours',         cron: '0 */6 * * *', desc: 'Runs at 00:00, 06:00, 12:00, 18:00' },
  { label: 'Every 12 hours',        cron: '0 */12 * * *',desc: 'Runs at 00:00 and 12:00 daily' },
  { label: 'Daily at 2:00 AM',      cron: '0 2 * * *',   desc: 'Once per day, low-traffic window' },
  { label: 'Daily at 3:00 AM',      cron: '0 3 * * *',   desc: 'Once per day, quiet overnight' },
  { label: 'Weeknights at 1:00 AM', cron: '0 1 * * 1-5', desc: 'Mon–Fri, overnight only' },
  { label: 'Weekly — Sunday 4:00 AM', cron: '0 4 * * 0', desc: 'Once per week, early Sunday' },
  { label: 'Weekly — Saturday midnight', cron: '0 0 * * 6', desc: 'Saturday at 00:00' },
  { label: 'Monthly — 1st at 5:00 AM',  cron: '0 5 1 * *', desc: '1st of every month' },
]

const HOURS   = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = [0, 5, 10, 15, 20, 30, 45]
const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Mode = 'preset' | 'custom' | 'advanced'

function parseCron(cron: string) {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  return { min: parts[0], hr: parts[1], dom: parts[2], mon: parts[3], dow: parts[4] }
}

function buildCron(min: string, hr: string, dom: string, mon: string, dow: string) {
  return `${min} ${hr} ${dom} ${mon} ${dow}`
}

export const CronPicker: React.FC<Props> = ({ value, onChange, label }) => {
  const matchedPreset = PRESETS.find(p => p.cron === value)
  const initialMode: Mode = matchedPreset ? 'preset' : 'custom'

  const [mode, setMode] = useState<Mode>(initialMode)

  // Custom builder state
  const parsed   = parseCron(value)
  const [hour, setHour]   = useState(parsed?.hr === '*' ? 2 : parseInt(parsed?.hr || '2', 10))
  const [minute, setMinute] = useState(parsed?.min === '0' ? 0 : parseInt(parsed?.min || '0', 10))
  const [freq, setFreq]   = useState<'daily' | 'weekly' | 'weekdays' | 'monthly'>(
    parsed?.dow === '1-5' ? 'weekdays' :
    parsed?.dow !== '*' ? 'weekly' :
    parsed?.dom !== '*' ? 'monthly' : 'daily'
  )
  const [weekDay, setWeekDay] = useState(
    parsed?.dow !== '*' && parsed?.dow !== '1-5' ? parseInt(parsed?.dow || '0', 10) : 0
  )
  const [monthDay, setMonthDay] = useState(
    parsed?.dom !== '*' ? parseInt(parsed?.dom || '1', 10) : 1
  )

  useEffect(() => {
    if (PRESETS.find(p => p.cron === value)) setMode('preset')
  }, [value])

  const applyCustom = (
    f = freq, h = hour, m = minute, wd = weekDay, md = monthDay
  ) => {
    let dow = '*', dom = '*'
    if (f === 'weekly')   { dow = String(wd) }
    if (f === 'weekdays') { dow = '1-5' }
    if (f === 'monthly')  { dom = String(md) }
    onChange(buildCron(String(m), String(h), dom, '*', dow))
  }

  const fmt24 = (h: number, m: number) => {
    const hStr = String(h).padStart(2, '0')
    const mStr = String(m).padStart(2, '0')
    return `${hStr}:${mStr}`
  }

  const currentPreset = PRESETS.find(p => p.cron === value)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {label && (
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </label>
      )}

      {/* Mode tabs */}
      <div style={{ display: 'flex', gap: 4, background: 'var(--surface-1)', borderRadius: 'var(--r-sm)', padding: 3 }}>
        {(['preset', 'custom', 'advanced'] as Mode[]).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              flex: 1, padding: '5px 0', borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
              fontSize: 12, fontWeight: 600,
              background: mode === m ? 'var(--blue-500)' : 'transparent',
              color: mode === m ? '#fff' : 'var(--text-muted)',
              transition: 'background 0.15s',
            }}
          >
            {m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      {/* Preset mode */}
      {mode === 'preset' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {PRESETS.map(p => (
            <button
              key={p.cron}
              type="button"
              onClick={() => onChange(p.cron)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px', borderRadius: 'var(--r-md)', border: 'none', cursor: 'pointer',
                background: value === p.cron ? 'var(--blue-dim)' : 'var(--surface-1)',
                color: 'var(--text-primary)',
                outline: value === p.cron ? '2px solid var(--blue-500)' : '2px solid transparent',
                textAlign: 'left', transition: 'all 0.15s',
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{p.desc}</div>
              </div>
              <code style={{
                fontSize: 11, fontFamily: 'monospace', padding: '2px 6px',
                background: 'var(--surface-3)', borderRadius: 4,
                color: 'var(--text-muted)', whiteSpace: 'nowrap',
              }}>
                {p.cron}
              </code>
            </button>
          ))}
        </div>
      )}

      {/* Custom builder mode */}
      {mode === 'custom' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Frequency */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>
              How often?
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
              {(['daily', 'weekdays', 'weekly', 'monthly'] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  onClick={() => { setFreq(f); applyCustom(f) }}
                  style={{
                    padding: '7px 0', borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 600,
                    background: freq === f ? 'var(--blue-500)' : 'var(--surface-1)',
                    color: freq === f ? '#fff' : 'var(--text-muted)',
                  }}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Day of week (weekly only) */}
          {freq === 'weekly' && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>
                Which day?
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
                {DAYS_OF_WEEK.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => { setWeekDay(i); applyCustom(freq, hour, minute, i) }}
                    style={{
                      padding: '6px 0', borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
                      fontSize: 11, fontWeight: 600,
                      background: weekDay === i ? 'var(--indigo-500, #6366f1)' : 'var(--surface-1)',
                      color: weekDay === i ? '#fff' : 'var(--text-muted)',
                    }}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Day of month (monthly only) */}
          {freq === 'monthly' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                Day of month
              </div>
              <select
                value={monthDay}
                onChange={e => { const v = parseInt(e.target.value, 10); setMonthDay(v); applyCustom(freq, hour, minute, weekDay, v) }}
                style={{ flex: 1, padding: '6px 8px', borderRadius: 'var(--r-sm)', background: 'var(--surface-1)', border: '1px solid var(--surface-4)', color: 'var(--text-primary)', fontSize: 13 }}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                  <option key={d} value={d}>{d}{['st','nd','rd'][d-1] || 'th'}</option>
                ))}
              </select>
            </div>
          )}

          {/* Time */}
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>
                Hour
              </div>
              <select
                value={hour}
                onChange={e => { const v = parseInt(e.target.value, 10); setHour(v); applyCustom(freq, v, minute) }}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 'var(--r-sm)', background: 'var(--surface-1)', border: '1px solid var(--surface-4)', color: 'var(--text-primary)', fontSize: 13 }}
              >
                {HOURS.map(h => (
                  <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>
                Minute
              </div>
              <select
                value={minute}
                onChange={e => { const v = parseInt(e.target.value, 10); setMinute(v); applyCustom(freq, hour, v) }}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 'var(--r-sm)', background: 'var(--surface-1)', border: '1px solid var(--surface-4)', color: 'var(--text-primary)', fontSize: 13 }}
              >
                {MINUTES.map(m => (
                  <option key={m} value={m}>:{String(m).padStart(2,'0')}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Live preview */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--surface-1)', borderRadius: 'var(--r-sm)',
            padding: '8px 12px',
          }}>
            <Info size={13} color="var(--blue-400, #60a5fa)" />
            <div style={{ flex: 1, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>Runs </span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                {freq === 'daily'    && `daily at ${fmt24(hour, minute)}`}
                {freq === 'weekdays' && `Mon–Fri at ${fmt24(hour, minute)}`}
                {freq === 'weekly'   && `every ${DAYS_OF_WEEK[weekDay]} at ${fmt24(hour, minute)}`}
                {freq === 'monthly'  && `on the ${monthDay}${['st','nd','rd'][monthDay-1]||'th'} at ${fmt24(hour, minute)}`}
              </span>
            </div>
            <code style={{
              fontSize: 11, fontFamily: 'monospace', padding: '2px 6px',
              background: 'var(--surface-3)', borderRadius: 4, color: 'var(--text-muted)',
            }}>
              {value}
            </code>
          </div>
        </div>
      )}

      {/* Advanced / raw cron mode */}
      {mode === 'advanced' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="0 2 * * *"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 'var(--r-sm)',
              background: 'var(--surface-1)', border: '1px solid var(--surface-4)',
              color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 14,
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 4, textAlign: 'center' }}>
            {['Minute', 'Hour', 'Dom', 'Month', 'Dow'].map(f => (
              <div key={f} style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {f}
              </div>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Standard 5-field cron. Use <code>*</code> for "every", <code>*/n</code> for intervals,
            <code>1-5</code> for ranges. Example: <code>0 3 * * 1</code> = every Monday at 03:00.
          </p>
        </div>
      )}

      {/* Selected cron summary (all modes except when we just showed it) */}
      {mode !== 'custom' && mode !== 'advanced' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--surface-1)', borderRadius: 'var(--r-sm)',
          padding: '6px 10px', fontSize: 12,
        }}>
          <Info size={12} color="var(--blue-400, #60a5fa)" />
          {currentPreset
            ? <span style={{ color: 'var(--text-muted)' }}>{currentPreset.desc}</span>
            : <span style={{ color: 'var(--text-muted)' }}>Custom schedule: <code style={{ fontFamily: 'monospace' }}>{value}</code></span>}
        </div>
      )}
    </div>
  )
}
