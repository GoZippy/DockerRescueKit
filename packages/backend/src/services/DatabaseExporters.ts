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
  | {
      kind: 'influxdb'
      container: string
      version: 'v1' | 'v2'
      token?: string
      org?: string
      bucket?: string
      db?: string
      outPath?: string
    }
  | {
      kind: 'mssql'
      container: string
      db: string
      server?: string
      authMode?: 'windows' | 'sql'
      user?: string
      password?: string
      outPath?: string
    }
  | {
      kind: 'couchdb'
      container: string
      /** CouchDB admin username. Defaults to 'admin'. */
      user?: string
      /** Name of an env var on the container holding the admin password.
       *  Must be a valid POSIX env-var name. Never embedded in the command. */
      passwordEnv: string
      /** CouchDB HTTP port inside the container. Defaults to 5984. */
      port?: number
      /** Explicit list of databases to export. Defaults to all non-system DBs. */
      databases?: string[]
      /** Include _replicator and _users in the default-all export. Defaults to false. */
      includeSystemDbs?: boolean
      /** Output directory inside the container. Defaults to /var/backups/drk-couchdb. */
      outPath?: string
    }

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
      case 'influxdb': {
        const out = exporter.outPath || '/var/backups/drk-influxdb'
        if (exporter.version === 'v2') {
          // influx CLI (v2): writes a directory of files. Token can come from
          // the env so we only inject it when the caller explicitly set one.
          const tokenArg = exporter.token ? `--token ${shellEscape(exporter.token)} ` : ''
          const orgArg = exporter.org ? `--org ${shellEscape(exporter.org)} ` : ''
          const bucketArg = exporter.bucket ? `--bucket ${shellEscape(exporter.bucket)} ` : ''
          return [
            'sh', '-c',
            `mkdir -p ${shellEscape(out)} && ` +
            `influx backup ${tokenArg}${orgArg}${bucketArg}${shellEscape(out)}`
          ]
        }
        // v1: influxd backup -portable [-db <db>] <path>
        const dbArg = exporter.db ? `-db ${shellEscape(exporter.db)} ` : ''
        return [
          'sh', '-c',
          `mkdir -p ${shellEscape(out)} && ` +
          `influxd backup -portable ${dbArg}${shellEscape(out)}`
        ]
      }
      case 'mssql': {
        const out = exporter.outPath || '/var/backups/drk-mssql.bak'
        const server = exporter.server || '.'
        const authMode = exporter.authMode || 'windows'
        const authArgs = authMode === 'sql'
          ? `-U ${shellEscape(exporter.user || 'sa')} -P ${shellEscape(exporter.password || '')}`
          : '-E'
        // WITH INIT overwrites instead of appending, so re-runs don't grow the
        // .bak with stacked copies. COMPRESSION isn't supported on Express
        // edition, so we omit it for portability across SKUs.
        const query = `BACKUP DATABASE [${exporter.db}] TO DISK = N'${out}' WITH INIT`
        return [
          'sh', '-c',
          `mkdir -p $(dirname ${shellEscape(out)}) && ` +
          `sqlcmd -S ${shellEscape(server)} ${authArgs} -Q ${shellEscape(query)}`
        ]
      }
      case 'couchdb': {
        // passwordEnv must be a POSIX env-var name — validated here so a bad
        // config fails fast rather than producing a shell injection vector.
        if (!isPosixEnvVarName(exporter.passwordEnv)) {
          throw new Error(
            `[db-exporter:couchdb] passwordEnv must be a POSIX env-var name ` +
            `(^[A-Za-z_][A-Za-z0-9_]*$), got ${JSON.stringify(exporter.passwordEnv).slice(0, 40)}`
          )
        }
        const out = exporter.outPath || '/var/backups/drk-couchdb'
        const user = exporter.user || 'admin'
        const port = exporter.port || 5984
        const base = `http://${shellEscape(user)}:"$${exporter.passwordEnv}"@localhost:${port}`

        // Determine which databases to export. If the caller lists them
        // explicitly we honour that verbatim. Otherwise we fetch /_all_dbs and
        // filter out the two system databases unless includeSystemDbs is set.
        //
        // HONEST LIMIT: this is a logical JSON export produced via
        // GET /{db}/_all_docs?include_docs=true&attachments=true (base64).
        // Each database lands as one <db>.json file that can be replayed into
        // a fresh CouchDB instance with POST /{db}/_bulk_docs. It is NOT a
        // binary .couch file copy and does not preserve internal sequence
        // numbers, compaction state, or design-document change history.
        if (exporter.databases && exporter.databases.length > 0) {
          // Explicit list — emit a per-db curl for each, joined with &&.
          const exportLines = exporter.databases.map(db => {
            const safeDb = shellEscape(db)
            const outFile = `${shellEscape(out)}/${safeDb}.json`
            return (
              `curl -fsSL -H 'Accept: application/json' ` +
              `"${base}/${safeDb}/_all_docs?include_docs=true&attachments=true" > ${outFile}`
            )
          }).join(' && ')
          return [
            'sh', '-c',
            `mkdir -p ${shellEscape(out)} && ` + exportLines
          ]
        }

        // Default: discover all databases then filter system ones unless asked.
        // Shell pipeline:
        //  1. GET /_all_dbs → JSON array of names
        //  2. Strip brackets + quotes, split to lines, optionally filter _-prefixed
        //  3. For each name: GET /_all_docs?include_docs=true&attachments=true → file
        return [
          'sh', '-c',
          `mkdir -p ${shellEscape(out)} && ` +
          `DBS=$(curl -fsSL -H 'Accept: application/json' "${base}/_all_dbs" | ` +
          `tr -d '[] ' | tr ',' '\\n'` +
          (exporter.includeSystemDbs ? '' : ` | grep -v '^"_'`) +
          ` | tr -d '"') && ` +
          `for DB in $DBS; do ` +
          `  curl -fsSL -H 'Accept: application/json' ` +
          `"${base}/$DB/_all_docs?include_docs=true&attachments=true" ` +
          `> ${shellEscape(out)}/"$DB".json || exit 1; ` +
          `done`
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

/** POSIX env-var name validator — identical to the one in SmokeCheckRunners. */
function isPosixEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}
