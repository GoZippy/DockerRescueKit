import cron from 'node-cron'

/**
 * Time-zone handling for backup schedules.
 *
 * A policy's `schedule` (and `verifySchedule`) is a 5-field cron expression
 * evaluated as WALL-CLOCK time in the policy's IANA `timezone`, DST included.
 *
 * Why this exists: the backend runs inside a container whose TZ is unset, so
 * the process zone is UTC. The UI used to show "Daily at 02:00" as if it were
 * the user's local time while the scheduler fired it at 02:00 UTC, which for a
 * user in CDT meant 21:00. The zone is now explicit on every policy.
 *
 * Legacy rows (created before the column existed) have no timezone. They keep
 * running in UTC, exactly as before, so nothing shifts silently; the UI labels
 * them as UTC and offers a one-click switch.
 */

/** The zone a policy runs in when it does not carry one (legacy rows, and CLI/API creates that omit it). */
export const DEFAULT_SCHEDULE_TIMEZONE = 'UTC'

const MAX_TIMEZONE_LENGTH = 64

/**
 * True when `tz` is a time-zone name the runtime's ICU knows (e.g.
 * "America/Chicago", "UTC", "Europe/London").
 *
 * Fixed-offset spellings ("+05:00", "-0300") are rejected on purpose: they are
 * valid for Intl on recent Node versions but are not IANA zones, carry no DST
 * rules, and would silently stop tracking local time twice a year.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string') return false
  if (tz.length === 0 || tz.length > MAX_TIMEZONE_LENGTH) return false
  if (tz !== tz.trim()) return false
  if (/^[+-]/.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * The zone a policy's cron is evaluated in. A missing/empty value means a
 * legacy policy and resolves to UTC. A stored value this runtime cannot
 * resolve also resolves to UTC (a missed zone must never stop backups from
 * running); `usedFallback` lets the caller log it loudly.
 */
export function resolvePolicyTimezone(policy: { timezone?: string | null }): { timezone: string; usedFallback: boolean } {
  const tz = policy.timezone
  if (tz === undefined || tz === null || tz === '') {
    return { timezone: DEFAULT_SCHEDULE_TIMEZONE, usedFallback: false }
  }
  if (isValidTimeZone(tz)) return { timezone: tz, usedFallback: false }
  return { timezone: DEFAULT_SCHEDULE_TIMEZONE, usedFallback: true }
}

export function effectiveTimezone(policy: { timezone?: string | null }): string {
  return resolvePolicyTimezone(policy).timezone
}

/**
 * The next `count` instants `expression` fires in `timezone`, computed by
 * node-cron itself (the same engine that will fire the job), so the preview
 * can never disagree with the scheduler. Returns [] for an invalid
 * expression or zone instead of throwing.
 *
 * Nothing is scheduled: the task is created stopped, never started, and
 * destroyed again before returning.
 */
export function nextRuns(expression: string, timezone: string, count = 1): Date[] {
  if (!cron.validate(expression) || !isValidTimeZone(timezone)) return []
  let task: ReturnType<typeof cron.createTask> | undefined
  try {
    task = cron.createTask(expression, () => undefined, { timezone })
    return task.getNextRuns(count)
  } catch {
    return []
  } finally {
    // createTask registers the task in node-cron's global registry; destroy it
    // so a preview per policy per request does not accumulate.
    try { void task?.destroy() } catch { /* nothing to release */ }
  }
}

export function nextRun(expression: string, timezone: string): Date | null {
  return nextRuns(expression, timezone, 1)[0] ?? null
}
