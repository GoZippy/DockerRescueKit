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
})
