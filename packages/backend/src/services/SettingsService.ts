import cron from 'node-cron'
import { Database } from '../db/Database'
import type { GuardScope, GuardSettings } from '@docker-rescue-kit/shared'
import {
  DEFAULT_GUARD_SETTINGS,
  GUARD_SCOPES,
  GUARD_SETTINGS_PREFIX,
} from './GuardTypes'

export class SettingsService {
  constructor(private db: Database) {}

  public async getSetting(key: string, defaultValue?: string): Promise<string | undefined> {
    const val = await this.db.getSetting(key)
    return val !== null ? val : defaultValue
  }

  public async saveSetting(key: string, value: string): Promise<void> {
    await this.db.saveSetting(key, value)
  }

  public async getBooleanSetting(key: string, defaultValue: boolean = false): Promise<boolean> {
    const val = await this.getSetting(key)
    if (val === undefined) return defaultValue
    return val === 'true'
  }

  public async saveBooleanSetting(key: string, value: boolean): Promise<void> {
    await this.saveSetting(key, value ? 'true' : 'false')
  }

  // ===========================================================================
  // PG-1.1 Prune Guard settings — see docs/design/PRUNE_GUARD.md §8.1
  // Persisted one row per field under `guard.<field>`, so individual fields can
  // be edited without a restart of the snapshot path (the cron itself follows
  // the same restart-to-reload caveat the ExportService cron documents).
  // ===========================================================================

  /** Defaults (§6.3/§17) merged with any stored `guard.*` overrides. */
  public async getGuardSettings(): Promise<GuardSettings> {
    const merged: GuardSettings = { ...DEFAULT_GUARD_SETTINGS }

    const enabled = await this.getSetting(GUARD_SETTINGS_PREFIX + 'enabled')
    if (enabled !== undefined) merged.enabled = enabled === 'true'

    const scope = await this.getSetting(GUARD_SETTINGS_PREFIX + 'scope')
    if (scope !== undefined && GUARD_SCOPES.includes(scope as GuardScope)) {
      merged.scope = scope as GuardScope
    }

    const diskBudgetMb = await this.getSetting(GUARD_SETTINGS_PREFIX + 'diskBudgetMb')
    if (diskBudgetMb !== undefined) {
      const n = parseInt(diskBudgetMb, 10)
      if (Number.isInteger(n) && n > 0) merged.diskBudgetMb = n
    }

    const perVolumeCapMb = await this.getSetting(GUARD_SETTINGS_PREFIX + 'perVolumeCapMb')
    if (perVolumeCapMb !== undefined) {
      const n = parseInt(perVolumeCapMb, 10)
      if (Number.isInteger(n) && n > 0) merged.perVolumeCapMb = n
    }

    const ttlHours = await this.getSetting(GUARD_SETTINGS_PREFIX + 'ttlHours')
    if (ttlHours !== undefined) {
      const n = parseInt(ttlHours, 10)
      if (Number.isInteger(n) && n > 0) merged.ttlHours = n
    }

    const periodicCron = await this.getSetting(GUARD_SETTINGS_PREFIX + 'periodicCron')
    if (periodicCron !== undefined && cron.validate(periodicCron)) {
      merged.periodicCron = periodicCron
    }

    const failClosed = await this.getSetting(GUARD_SETTINGS_PREFIX + 'failClosed')
    if (failClosed !== undefined) merged.failClosed = failClosed === 'true'

    return merged
  }

  /**
   * Validate + persist a partial GuardSettings patch. Only the supplied fields
   * are written. Throws on any invalid field (cron via node-cron, budgets/caps
   * positive integers, scope a known enum) so a bad PUT never persists.
   */
  public async setGuardSettings(partial: Partial<GuardSettings>): Promise<GuardSettings> {
    if (partial.scope !== undefined && !GUARD_SCOPES.includes(partial.scope)) {
      throw new Error(`Invalid guard scope: ${partial.scope}`)
    }
    if (partial.periodicCron !== undefined && !cron.validate(partial.periodicCron)) {
      throw new Error(`Invalid guard cron: ${partial.periodicCron}`)
    }
    const positiveIntFields: Array<keyof GuardSettings> = ['diskBudgetMb', 'perVolumeCapMb', 'ttlHours']
    for (const field of positiveIntFields) {
      const v = partial[field]
      if (v !== undefined && (!Number.isInteger(v) || (v as number) <= 0)) {
        throw new Error(`Invalid guard ${field}: must be a positive integer`)
      }
    }

    if (partial.enabled !== undefined) {
      await this.saveBooleanSetting(GUARD_SETTINGS_PREFIX + 'enabled', partial.enabled)
    }
    if (partial.scope !== undefined) {
      await this.saveSetting(GUARD_SETTINGS_PREFIX + 'scope', partial.scope)
    }
    if (partial.diskBudgetMb !== undefined) {
      await this.saveSetting(GUARD_SETTINGS_PREFIX + 'diskBudgetMb', String(partial.diskBudgetMb))
    }
    if (partial.perVolumeCapMb !== undefined) {
      await this.saveSetting(GUARD_SETTINGS_PREFIX + 'perVolumeCapMb', String(partial.perVolumeCapMb))
    }
    if (partial.ttlHours !== undefined) {
      await this.saveSetting(GUARD_SETTINGS_PREFIX + 'ttlHours', String(partial.ttlHours))
    }
    if (partial.periodicCron !== undefined) {
      await this.saveSetting(GUARD_SETTINGS_PREFIX + 'periodicCron', partial.periodicCron)
    }
    if (partial.failClosed !== undefined) {
      await this.saveBooleanSetting(GUARD_SETTINGS_PREFIX + 'failClosed', partial.failClosed)
    }

    return this.getGuardSettings()
  }
}
