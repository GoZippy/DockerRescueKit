/**
 * Schedule time-zone helpers for the UI.
 *
 * A policy's cron runs as wall-clock time in the policy's IANA `timezone`
 * (evaluated by the backend scheduler). Policies created before the field
 * existed have none and run in UTC. Everything here only formats; the next-run
 * instant itself is computed server-side (`policy.nextRun`) so the UI can never
 * disagree with the scheduler.
 */

export const UTC = 'UTC'

interface ZonedPolicy {
  timezone?: string | null
  effectiveTimezone?: string | null
}

/** The browser's IANA zone ("America/Chicago"), or UTC when it cannot be determined. */
export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC
  } catch {
    return UTC
  }
}

/** True when `tz` is a name the browser's Intl knows. Offsets like "+05:00" are not IANA zones. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz !== tz.trim() || /^[+-]/.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The zone the scheduler evaluates the policy in. */
export function policyTimeZone(policy: ZonedPolicy): string {
  return policy.effectiveTimezone || policy.timezone || UTC
}

/** A pre-timezone policy: no zone stored, runs in UTC. */
export function isLegacyUtcPolicy(policy: ZonedPolicy): boolean {
  return !policy.timezone
}

/** All zone names the browser supports, for the editor's suggestions. UTC is always first. */
export function listTimeZones(): string[] {
  let zones: string[] = []
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    if (supported) zones = supported('timeZone')
  } catch {
    zones = []
  }
  return [UTC, ...zones.filter(z => z !== UTC)]
}

/**
 * The next run as a short local string in the viewer's own zone, e.g.
 * "Tue, Oct 6, 2:00 AM CDT". `displayZone` defaults to the browser zone;
 * `locale` to the browser locale (tests pin both).
 */
export function formatNextRun(
  iso: string | null | undefined,
  displayZone: string = getBrowserTimeZone(),
  locale?: string,
): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: displayZone, timeZoneName: 'short',
    }).format(date)
  } catch {
    return date.toISOString()
  }
}
