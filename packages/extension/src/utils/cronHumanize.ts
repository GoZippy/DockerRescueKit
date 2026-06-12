/**
 * Lightweight cron humanizer — no new npm deps.
 *
 * Matches the preset descriptions used by CronPicker, then falls back
 * to a small pattern matcher for common cron expressions.
 * Returns the raw cron string if no pattern matches.
 */

const PRESETS: Record<string, string> = {
  '0 * * * *':    'Every hour',
  '0 */6 * * *':  'Every 6 hours',
  '0 */12 * * *': 'Every 12 hours',
  '0 2 * * *':    'Daily at 02:00',
  '0 3 * * *':    'Daily at 03:00',
  '0 1 * * 1-5':  'Weeknights at 01:00',
  '0 4 * * 0':    'Weekly — Sunday 04:00',
  '0 0 * * 6':    'Weekly — Saturday midnight',
  '0 5 1 * *':    'Monthly — 1st at 05:00',
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function pad2(n: number) { return String(n).padStart(2, '0') }

export function humanizeCron(cron: string): string {
  const trimmed = cron.trim()
  if (PRESETS[trimmed]) return PRESETS[trimmed]

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return cron

  const [min, hr, dom, , dow] = parts

  // Simple "at HH:MM" extraction helper
  const timeStr = () => {
    const h = parseInt(hr, 10)
    const m = parseInt(min, 10)
    if (Number.isNaN(h) || Number.isNaN(m)) return null
    return `${pad2(h)}:${pad2(m)}`
  }

  // Daily: "0 HH * * *"
  if (dow === '*' && dom === '*' && !hr.includes('/') && !min.includes('/')) {
    const t = timeStr()
    if (t) return `Daily at ${t}`
  }

  // Every N hours: "0 */N * * *"
  if (min === '0' && hr.startsWith('*/') && dom === '*' && dow === '*') {
    const n = hr.slice(2)
    return `Every ${n} hours`
  }

  // Every N minutes: "*/N * * * *"
  if (min.startsWith('*/') && hr === '*' && dom === '*' && dow === '*') {
    const n = min.slice(2)
    return `Every ${n} minutes`
  }

  // Weekly: "0 HH * * D" (single digit dow)
  if (dom === '*' && /^\d$/.test(dow) && !hr.includes('/') && !min.includes('/')) {
    const t = timeStr()
    const dayIdx = parseInt(dow, 10)
    if (t && dayIdx >= 0 && dayIdx <= 6) {
      return `Weekly — ${DAYS[dayIdx]} at ${t}`
    }
  }

  // Weekdays: "0 HH * * 1-5"
  if (dom === '*' && dow === '1-5' && !hr.includes('/') && !min.includes('/')) {
    const t = timeStr()
    if (t) return `Weekdays at ${t}`
  }

  // Monthly: "0 HH D * *" (single dom)
  if (dow === '*' && /^\d+$/.test(dom) && !hr.includes('/') && !min.includes('/')) {
    const t = timeStr()
    const d = parseInt(dom, 10)
    const suffix = d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th'
    if (t) return `Monthly — ${d}${suffix} at ${t}`
  }

  return cron
}
