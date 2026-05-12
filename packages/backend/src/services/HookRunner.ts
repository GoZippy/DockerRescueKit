import { BackupPolicy } from '@docker-rescue-kit/shared'
import { DockerService } from './DockerService'

export type HookPhase = 'pre' | 'post'

export interface HookContext {
  phase: HookPhase
  policy: BackupPolicy
}

/**
 * A hook is specified as a string. The supported formats are:
 *
 *   exec:<container>:<cmd...>     Run via `docker exec`. Preferred.
 *   webhook:<method>:<url>        Fire an HTTP request.
 *   log:<message>                 No-op except a log line. Useful for testing.
 *
 * Anything else is refused — we intentionally don't shell out on the host by
 * default because this process often runs as a privileged Docker-socket user.
 */
export class HookRunner {
  constructor(private docker: DockerService) {}

  public async runAll(hooks: string[], ctx: HookContext): Promise<void> {
    for (const hook of hooks) {
      await this.runOne(hook, ctx)
    }
  }

  public async runOne(hook: string, ctx: HookContext): Promise<void> {
    const execMatch = /^exec:([^:]+):(.+)$/.exec(hook)
    if (execMatch) {
      const [, container, rest] = execMatch
      const argv = this.tokenize(rest)
      const res = await this.docker.execInContainer(container, argv, { timeoutMs: 5 * 60_000 })
      if (res.exitCode !== 0) {
        throw new Error(`[${ctx.phase}] exec:${container} exited ${res.exitCode}: ${res.stderr || res.stdout}`)
      }
      return
    }

    const webhookMatch = /^webhook:(GET|POST):(.+)$/i.exec(hook)
    if (webhookMatch) {
      const [, method, url] = webhookMatch
      const { default: axios } = await import('axios')
      await axios.request({ url, method: method as any, timeout: 30_000 })
      return
    }

    const logMatch = /^log:(.+)$/.exec(hook)
    if (logMatch) {
      console.log(`[Hook:${ctx.phase}] ${logMatch[1]}`)
      return
    }

    throw new Error(`Unsupported hook format: ${hook}. Use exec:<container>:<cmd>, webhook:<method>:<url>, or log:<msg>.`)
  }

  private tokenize(cmd: string): string[] {
    // Minimal whitespace tokenizer — intentionally does not honor shell quoting
    // because we don't want to approximate shell behavior.
    return cmd.split(/\s+/).filter(Boolean)
  }
}
