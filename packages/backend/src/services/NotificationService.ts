import { BackupPolicy, Backup, NotificationConfig } from '@docker-rescue-kit/shared'
import axios from 'axios'
import { logger } from '../utils/logger'

export type NotifyEvent = 'success' | 'failure'

/**
 * Minimal multi-channel notifier. Supports:
 *  - webhook  (generic POST with JSON body)
 *  - ntfy     (homelab-friendly push)
 *  - slack    (incoming webhook URL)
 *
 * Email is intentionally deferred — it requires SMTP config and per-provider
 * auth that belongs in a later iteration.
 */
export class NotificationService {
  public async notify(event: NotifyEvent, policy: BackupPolicy, backup: Backup): Promise<void> {
    if (!policy.notifications) return

    const message = this.buildMessage(event, policy, backup)
    for (const cfg of policy.notifications) {
      if (!this.shouldFire(cfg, event)) continue
      try {
        await this.dispatch(cfg, event, policy, backup, message)
      } catch (err) {
        logger.error({ channel: cfg.type, err }, '[Notify] dispatch failed')
      }
    }
  }

  private shouldFire(cfg: NotificationConfig, event: NotifyEvent): boolean {
    return cfg.events.includes(event) || cfg.events.includes('completion')
  }

  private buildMessage(event: NotifyEvent, policy: BackupPolicy, backup: Backup): string {
    const header = event === 'success' ? 'Backup succeeded' : 'Backup FAILED'
    const targets = backup.targets.map(t => `${t.type}:${t.selector}`).join(', ')
    const durationSec = Math.round(backup.duration / 1000)
    const sizeMb = (backup.size / 1024 / 1024).toFixed(1)
    const lines = [
      `[DockerRescueKit] ${header}`,
      `Policy: ${policy.name}`,
      `Targets: ${targets || '(none)'}`,
      `Duration: ${durationSec}s`,
      `Size: ${sizeMb} MB`
    ]
    if (backup.error) lines.push(`Error: ${backup.error}`)
    return lines.join('\n')
  }

  private async dispatch(
    cfg: NotificationConfig,
    event: NotifyEvent,
    policy: BackupPolicy,
    backup: Backup,
    message: string
  ): Promise<void> {
    const config = cfg.config || {}
    switch (cfg.type) {
      case 'webhook': {
        await axios.post(config.url, {
          event,
          policyId: policy.id,
          policyName: policy.name,
          backupId: backup.id,
          status: backup.status,
          message,
          backup
        }, { timeout: 15_000 })
        return
      }
      case 'slack': {
        await axios.post(config.url, { text: message }, { timeout: 15_000 })
        return
      }
      case 'ntfy': {
        await axios.post(config.url, message, {
          headers: {
            'Content-Type': 'text/plain',
            Title: `DockerRescueKit: ${backup.status}`,
            Priority: event === 'failure' ? 'high' : 'default',
            Tags: event === 'failure' ? 'warning' : 'white_check_mark'
          },
          timeout: 15_000
        })
        return
      }
      case 'email': {
        // Deferred — log until SMTP transport is configured.
        console.log('[Notify:email]', message)
        return
      }
    }
  }
}
