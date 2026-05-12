import React, { useState, useEffect } from 'react'

interface Props {
  value: string
  onChange: (cron: string) => void
}

const presets = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 02:00', cron: '0 2 * * *' },
  { label: 'Daily at 03:00', cron: '0 3 * * *' },
  { label: 'Sundays 04:00', cron: '0 4 * * 0' },
  { label: '1st of month 05:00', cron: '0 5 1 * *' }
]

export const CronPicker: React.FC<Props> = ({ value, onChange }) => {
  const [mode, setMode] = useState<'preset' | 'advanced'>(
    presets.some(p => p.cron === value) ? 'preset' : 'advanced'
  )

  useEffect(() => {
    if (presets.some(p => p.cron === value)) setMode('preset')
  }, [value])

  return (
    <div className="space-y-2">
      <div className="flex gap-2 text-xs">
        <button
          onClick={() => setMode('preset')}
          className={`px-3 py-1 rounded ${mode === 'preset' ? 'bg-blue-600 text-white' : 'bg-white/5 text-slate-400'}`}
        >
          Preset
        </button>
        <button
          onClick={() => setMode('advanced')}
          className={`px-3 py-1 rounded ${mode === 'advanced' ? 'bg-blue-600 text-white' : 'bg-white/5 text-slate-400'}`}
        >
          Cron expression
        </button>
      </div>

      {mode === 'preset' ? (
        <select
          value={presets.find(p => p.cron === value)?.cron || presets[2].cron}
          onChange={e => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-white/10 text-sm"
        >
          {presets.map(p => (
            <option key={p.cron} value={p.cron}>{p.label} — {p.cron}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="0 2 * * *"
          className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-white/10 font-mono text-sm"
        />
      )}
      <p className="text-xs text-slate-500">
        Fields: minute · hour · day-of-month · month · day-of-week
      </p>
    </div>
  )
}
