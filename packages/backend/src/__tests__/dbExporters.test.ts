import { DatabaseExporterService } from '../services/DatabaseExporters'

describe('DatabaseExporterService.buildCommand', () => {
  const svc = new DatabaseExporterService({} as any)

  it('postgres uses pg_dumpall + gzip', () => {
    const cmd = svc.buildCommand({ kind: 'postgres', container: 'db' })
    expect(cmd[0]).toBe('sh')
    expect(cmd[2]).toContain('pg_dumpall')
    expect(cmd[2]).toContain('gzip')
  })

  it('mysql passes password via -p and pipes to gzip', () => {
    const cmd = svc.buildCommand({ kind: 'mysql', container: 'db', password: "p'w" })
    expect(cmd[2]).toContain('mysqldump')
    expect(cmd[2]).toContain('--all-databases')
    // Password with quote is single-quote escaped.
    expect(cmd[2]).toContain(`-p'p'\\''w'`)
  })

  it('redis triggers BGSAVE', () => {
    const cmd = svc.buildCommand({ kind: 'redis', container: 'cache' })
    expect(cmd[2]).toContain('BGSAVE')
  })

  it('mongodb runs mongodump to a directory', () => {
    const cmd = svc.buildCommand({ kind: 'mongodb', container: 'mongo' })
    expect(cmd[2]).toContain('mongodump')
  })

  it('sqlite uses .backup', () => {
    const cmd = svc.buildCommand({ kind: 'sqlite', container: 'app', dbPath: '/data/app.db' })
    expect(cmd[2]).toContain('.backup')
    expect(cmd[2]).toContain('/data/app.db')
  })

  describe('influxdb', () => {
    it('v2 uses `influx backup` and omits token/org/bucket when not provided', () => {
      const cmd = svc.buildCommand({ kind: 'influxdb', container: 'influx', version: 'v2' })
      expect(cmd[2]).toContain('influx backup')
      expect(cmd[2]).not.toContain('--token')
      expect(cmd[2]).not.toContain('--org')
      expect(cmd[2]).not.toContain('--bucket')
      expect(cmd[2]).toContain('/var/backups/drk-influxdb')
    })

    it('v2 wires through token, org, and bucket when set', () => {
      const cmd = svc.buildCommand({
        kind: 'influxdb', container: 'influx', version: 'v2',
        token: 'abc=def', org: 'acme', bucket: 'metrics',
      })
      // `=` is not in the safe-char set so the token gets single-quoted.
      expect(cmd[2]).toContain("--token 'abc=def'")
      expect(cmd[2]).toContain('--org acme')
      expect(cmd[2]).toContain('--bucket metrics')
    })

    it('v1 uses `influxd backup -portable` without -db when db is omitted', () => {
      const cmd = svc.buildCommand({ kind: 'influxdb', container: 'influx', version: 'v1' })
      expect(cmd[2]).toContain('influxd backup -portable')
      expect(cmd[2]).not.toContain('-db ')
    })

    it('v1 includes -db <name> when db is set', () => {
      const cmd = svc.buildCommand({
        kind: 'influxdb', container: 'influx', version: 'v1', db: 'telegraf',
      })
      expect(cmd[2]).toContain('-db telegraf')
    })
  })

  describe('mssql', () => {
    it('defaults to Windows auth (-E) and server "."', () => {
      const cmd = svc.buildCommand({ kind: 'mssql', container: 'sql', db: 'AppDb' })
      expect(cmd[2]).toContain('sqlcmd -S .')
      expect(cmd[2]).toContain('-E')
      expect(cmd[2]).not.toContain('-U ')
      expect(cmd[2]).toContain('BACKUP DATABASE [AppDb]')
      // WITH INIT (not COMPRESSION) for Express-edition portability
      expect(cmd[2]).toContain('WITH INIT')
      expect(cmd[2]).not.toContain('COMPRESSION')
    })

    it('SQL auth wires -U + -P and falls back to "sa" when user is omitted', () => {
      const cmd = svc.buildCommand({
        kind: 'mssql', container: 'sql', db: 'AppDb',
        authMode: 'sql', password: 's3cret!',
      })
      expect(cmd[2]).toContain('-U sa')
      // password has a non-safe char and gets single-quote escaped
      expect(cmd[2]).toContain("-P 's3cret!'")
      expect(cmd[2]).not.toContain('-E')
    })

    it('respects custom server (e.g. named instance) and custom outPath', () => {
      const cmd = svc.buildCommand({
        kind: 'mssql', container: 'sql', db: 'AppDb',
        server: '.\\SQLEXPRESS', outPath: '/srv/backups/app.bak',
      })
      // server has a backslash so it gets single-quoted by shellEscape
      expect(cmd[2]).toContain("sqlcmd -S '.\\SQLEXPRESS'")
      // The whole BACKUP query is shell-escaped, so the inner N'...' quotes
      // appear as `'\\''` runs. Just check the path and the literal `TO DISK`.
      expect(cmd[2]).toContain('TO DISK = N')
      expect(cmd[2]).toContain('/srv/backups/app.bak')
    })

    it('escapes single quotes inside SQL auth passwords', () => {
      const cmd = svc.buildCommand({
        kind: 'mssql', container: 'sql', db: 'AppDb',
        authMode: 'sql', user: 'svc', password: "it's-fine",
      })
      // shellEscape doubles single-quotes via the '\'' pattern
      expect(cmd[2]).toContain(`-P 'it'\\''s-fine'`)
    })
  })
})
