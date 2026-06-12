import type { GuardScope, GuardSettings } from '@docker-rescue-kit/shared'

/**
 * PG-1.1 backend-local constants for Prune Guard.
 *
 * Audit event type strings (docs/design/PRUNE_GUARD.md §13) and the
 * GuardSettings defaults / persistence keys (§6.3, §8.1). Kept backend-side so
 * the shared package stays a pure type surface and the MCP/proxy front-ends
 * (which call the same audit + settings paths) reference one source of truth.
 */

/**
 * Audit event `type` constants for every guard.* action (§13). These are the
 * `action` passed to AuditService.record(...).
 */
export const GUARD_AUDIT_EVENTS = {
  snapshot: 'guard.snapshot',
  restore: 'guard.restore',
  skipped: 'guard.skipped',
  too_late: 'guard.too_late',
  snapshot_failed: 'guard.snapshot_failed',
  expired: 'guard.expired',
} as const

export type GuardAuditEvent = typeof GUARD_AUDIT_EVENTS[keyof typeof GUARD_AUDIT_EVENTS]

/** Settings-table key prefix; one row per GuardSettings field (`guard.<field>`). */
export const GUARD_SETTINGS_PREFIX = 'guard.'

/** Allowed scope values (§8.1). 'off' disables the guard entirely. */
export const GUARD_SCOPES: readonly GuardScope[] = [
  'protected',
  'named',
  'all-named-under-cap',
  'off',
]

/**
 * Resolved defaults (§6.3, §17). scope='named', 2048MB budget, 512MB per-volume
 * cap, 72h TTL, every-6h floor cron, fail-open.
 */
export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  enabled: true,
  scope: 'named',
  diskBudgetMb: 2048,
  perVolumeCapMb: 512,
  ttlHours: 72,
  periodicCron: '0 */6 * * *',
  failClosed: false,
}
