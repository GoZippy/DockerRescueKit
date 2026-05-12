import { DockerService } from './DockerService'

/**
 * Typed DB-exporter hook configuration. In addition to the free-form
 * `exec:/webhook:/log:` strings accepted by HookRunner, policies can declare
 * structured DB backups that get rendered into the right `docker exec` line
 * at run time. This is what homelabbers actually want: "I have a Postgres
 * container — dump it before the filesystem snapshot".
 */
export type DatabaseExporter =
  | { kind: 'postgres'; container: string; user?: string; db?: string; outPath?: string }
  | { kind: 'mysql'; container: string; user?: string; password?: string; db?: string; outPath?: string }
  | { kind: 'redis'; container: string }
  | { kind: 'mongodb'; container: string; outPath?: string }
  | { kind: 'sqlite'; container: string; dbPath: string; outPath?: string }

export class DatabaseExporterService {
  constructor(private docker: DockerService) {}

  /**
   * Expand a structured exporter into a real exec call on the target
   * container. Returns the captured stdout/stderr so HookRunner errors carry
   * useful detail.
   */
  public async run(exporter: DatabaseExporter): Promise<void> {
    const cmd = this.buildCommand(exporter)
    const res = await this.docker.execInContainer(exporter.container, cmd, { timeoutMs: 15 * 60_000 })
    if (res.exitCode !== 0) {
      throw new Error(
        `[db-exporter:${exporter.kind}] container=${exporter.container} exit=${res.exitCode} ${res.stderr || res.stdout}`
      )
    }
  }

  /**
   * Build the shell command we will run inside the container. We deliberately
   * write the dump to a file *inside the container's own filesystem* (under
   * /var/backups by default) — the subsequent volume/container export then
   * picks it up. That way we don't need to wrangle streams through Dockerode.
   */
  public buildCommand(exporter: DatabaseExporter): string[] {
    switch (exporter.kind) {
      case 'postgres': {
        const user = exporter.user || 'postgres'
        const out = exporter.outPath || '/var/backups/drk-postgres.sql.gz'
        const dbArg = exporter.db ? `-d ${shellEscape(exporter.db)}` : ''
        return [
          'sh', '-c',
          `mkdir -p $(dirname ${shellEscape(out)}) && ` +
          `PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -U ${shellEscape(user)} ${dbArg} | gzip -c > ${shellEscape(out)}`
        ]
      }
      case 'mysql': {
        const user = exporter.user || 'root'
        const out = exporter.outPath || '/var/backups/drk-mysql.sql.gz'
        const pwd = exporter.password ? `-p${shellEscape(exporter.password)}` : ''
        const dbArg = exporter.db ? shellEscape(exporter.db) : '--all-databases'
        return [
          'sh', '-c',
          `mkdir -p $(dirname ${shellEscape(out)}) && ` +
          `mysqldump -u ${shellEscape(user)} ${pwd} ${dbArg} | gzip -c > ${shellEscape(out)}`
        ]
      }
      case 'redis': {
        return [
          'sh', '-c',
          'redis-cli BGSAVE && ' +
          'while [ "$(redis-cli LASTSAVE)" = "$(redis-cli LASTSAVE)" ]; do sleep 1; break; done'
        ]
      }
      case 'mongodb': {
        const out = exporter.outPath || '/var/backups/drk-mongo'
        return [
          'sh', '-c',
          `mkdir -p ${shellEscape(out)} && mongodump --out ${shellEscape(out)}`
        ]
      }
      case 'sqlite': {
        const out = exporter.outPath || `/var/backups/drk-sqlite.db`
        return [
          'sh', '-c',
          `mkdir -p $(dirname ${shellEscape(out)}) && ` +
          `sqlite3 ${shellEscape(exporter.dbPath)} ".backup '${shellEscape(out)}'"`
        ]
      }
    }
  }
}

function shellEscape(input: string): string {
  // Minimal single-quote escape — fine for values we already control from
  // trusted config.
  if (/^[A-Za-z0-9_./-]+$/.test(input)) return input
  return `'${input.replace(/'/g, `'\\''`)}'`
}
