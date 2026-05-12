import { PolicyManager } from './PolicyManager'
import { Database } from '../db/Database'

/**
 * Renders Prometheus-format metrics for backup observability.
 *
 * Homelabbers already run Prometheus/Grafana; a cheap /metrics endpoint is
 * the highest-leverage integration we can ship.
 */
export class MetricsService {
  constructor(private policyManager: PolicyManager, private db?: Database) {}

  public async render(): Promise<string> {
    const policies = await this.policyManager.listPolicies()
    const lines: string[] = []

    lines.push('# HELP drk_policies_total Number of backup policies configured.')
    lines.push('# TYPE drk_policies_total gauge')
    lines.push(`drk_policies_total ${policies.length}`)

    lines.push('# HELP drk_policies_enabled Number of enabled backup policies.')
    lines.push('# TYPE drk_policies_enabled gauge')
    lines.push(`drk_policies_enabled ${policies.filter(p => p.enabled).length}`)

    lines.push('# HELP drk_backup_success_total Total successful backups per policy.')
    lines.push('# TYPE drk_backup_success_total counter')
    lines.push('# HELP drk_backup_failed_total Total failed backups per policy.')
    lines.push('# TYPE drk_backup_failed_total counter')
    lines.push('# HELP drk_backup_last_success_age_seconds Seconds since last successful backup.')
    lines.push('# TYPE drk_backup_last_success_age_seconds gauge')
    lines.push('# HELP drk_backup_last_size_bytes Size in bytes of the most recent successful backup.')
    lines.push('# TYPE drk_backup_last_size_bytes gauge')
    lines.push('# HELP drk_backup_last_duration_seconds Duration of the most recent successful backup.')
    lines.push('# TYPE drk_backup_last_duration_seconds gauge')

    const now = Date.now()
    for (const policy of policies) {
      const history = await this.policyManager.getBackupHistory(policy.id)
      const successes = history.filter(b => b.status === 'success')
      const failures = history.filter(b => b.status === 'failed')
      const lastSuccess = successes[0]

      const label = `policy_id="${escapeLabel(policy.id)}",policy_name="${escapeLabel(policy.name)}"`

      lines.push(`drk_backup_success_total{${label}} ${successes.length}`)
      lines.push(`drk_backup_failed_total{${label}} ${failures.length}`)

      if (lastSuccess) {
        const ageSec = Math.floor((now - lastSuccess.timestamp.getTime()) / 1000)
        lines.push(`drk_backup_last_success_age_seconds{${label}} ${ageSec}`)
        lines.push(`drk_backup_last_size_bytes{${label}} ${lastSuccess.size}`)
        lines.push(`drk_backup_last_duration_seconds{${label}} ${(lastSuccess.duration / 1000).toFixed(3)}`)
      }
    }

    // Verify metrics — surface last-verify-age and failure counts, which
    // operators actually want alerts on.
    if (this.db) {
      try {
        const verifyRecords = await this.db.getVerifyHistory()
        const verifyPassed = verifyRecords.filter((r: any) => r.ok)
        const verifyFailed = verifyRecords.filter((r: any) => !r.ok)
        lines.push('# HELP drk_verify_passed_total Total successful verify runs.')
        lines.push('# TYPE drk_verify_passed_total counter')
        lines.push(`drk_verify_passed_total ${verifyPassed.length}`)
        lines.push('# HELP drk_verify_failed_total Total failed verify runs.')
        lines.push('# TYPE drk_verify_failed_total counter')
        lines.push(`drk_verify_failed_total ${verifyFailed.length}`)
        if (verifyPassed.length > 0) {
          const last = verifyPassed[0]
          const ageSec = Math.floor((now - new Date(last.startedAt).getTime()) / 1000)
          lines.push('# HELP drk_verify_last_pass_age_seconds Seconds since the last passing verify run.')
          lines.push('# TYPE drk_verify_last_pass_age_seconds gauge')
          lines.push(`drk_verify_last_pass_age_seconds ${ageSec}`)
        }
      } catch { /* verify history may not be available */ }
    }

    return lines.join('\n') + '\n'
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
