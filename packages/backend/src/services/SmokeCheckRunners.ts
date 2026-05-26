import http from 'http'
import net from 'net'
import type { SmokeCheck, SmokeCheckResult } from '@docker-rescue-kit/shared'
import { DockerService } from './DockerService'

/**
 * Smoke-check runner registry for the restore-rehearsal workflow (R-1).
 *
 * Each runner takes one `SmokeCheck`, runs it against the sandbox stand-in
 * container, and returns a `SmokeCheckResult`. Runners are stateless and
 * pure-by-construction: they receive the docker handle and the
 * container-name remap from the caller; they never reach into module
 * scope.
 *
 * Adding a new kind: implement the runner here, register it in
 * `createSmokeCheckRegistry()`, and add the kind to the SmokeCheckKind
 * union in `@docker-rescue-kit/shared`.
 */

export interface SmokeCheckContext {
  /** Sandbox network name. Currently informational — the runners reach
   *  the stand-in container by name (Docker DNS on the sandbox network
   *  resolves logical names), so we don't open ports to the host. */
  network: string
  /** Logical-container-name → stand-in-container-name map. The smoke
   *  check declares the *original* container name; the runner translates
   *  to the actual sandbox container name before issuing the call. */
  containerNameMap: Record<string, string>
  docker: DockerService
  /** Aborted when the rehearsal-wide timeout fires or when the operator
   *  POSTs /api/rehearsals/:id/abort. */
  signal: AbortSignal
}

export interface SmokeCheckRunner {
  readonly kind: SmokeCheck['kind']
  run(check: SmokeCheck, ctx: SmokeCheckContext): Promise<SmokeCheckResult>
}

// ---------------------------------------------------------------------------
// HTTP runner
// ---------------------------------------------------------------------------
// We exec curl inside the stand-in container so requests stay on the sandbox
// network and never reach the host. This avoids needing to publish ports and
// keeps the security guarantees from the design spec (§6: no published ports,
// no host network).
class HttpRunner implements SmokeCheckRunner {
  readonly kind = 'http' as const

  async run(check: SmokeCheck, ctx: SmokeCheckContext): Promise<SmokeCheckResult> {
    if (check.kind !== 'http') throw new Error('runner kind mismatch')
    const started = Date.now()
    const result: SmokeCheckResult = {
      check,
      ok: false,
      attempt: 1,
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      durationMs: 0,
    }

    const containerName = ctx.containerNameMap[check.container]
    if (!containerName) {
      return finalize(result, started, false, `container ${check.container} not in rehearsal map`)
    }

    const method = check.method || 'GET'
    const url = `http://${check.container}:${check.port}${check.path || '/'}`
    const timeout = Math.ceil((check.timeoutMs ?? 10_000) / 1000)

    // -s = silent, -S = show errors, -o = body file, -w writes status code
    const cmd = [
      'sh', '-c',
      `curl -s -S -o /tmp/drk-probe-body -w '%{http_code}' --max-time ${timeout} -X ${method} '${url}' && echo && cat /tmp/drk-probe-body 2>/dev/null || true`,
    ]

    try {
      const res = await ctx.docker.execInContainer(containerName, cmd, { timeoutMs: check.timeoutMs ?? 10_000 })
      const [statusLine, ...bodyParts] = res.stdout.split('\n')
      const status = parseInt(statusLine.trim(), 10)
      const body = bodyParts.join('\n')

      if (Number.isNaN(status)) {
        return finalize(result, started, false, `unable to parse status from curl output: ${res.stdout.slice(0, 200)}`)
      }

      const statusOk = matchExpectedStatus(status, check.expectStatus)
      if (!statusOk) {
        return finalize(result, started, false, `got HTTP ${status}, expected ${formatExpectedStatus(check.expectStatus)}`)
      }
      if (check.bodyContains && !body.includes(check.bodyContains)) {
        return finalize(result, started, false, `HTTP ${status} OK but body did not contain ${JSON.stringify(check.bodyContains)}`)
      }
      return finalize(result, started, true, `HTTP ${status}`)
    } catch (err: any) {
      return finalize(result, started, false, err?.message || String(err))
    }
  }
}

type HttpExpectStatus = number | 'any_2xx' | 'any_3xx' | undefined

function matchExpectedStatus(actual: number, expected: HttpExpectStatus): boolean {
  if (expected === undefined || expected === null) return actual === 200
  if (expected === 'any_2xx') return actual >= 200 && actual < 300
  if (expected === 'any_3xx') return actual >= 300 && actual < 400
  return actual === expected
}

function formatExpectedStatus(expected: HttpExpectStatus): string {
  if (expected === undefined || expected === null) return '200'
  if (expected === 'any_2xx') return '2xx'
  if (expected === 'any_3xx') return '3xx'
  return String(expected)
}

// ---------------------------------------------------------------------------
// Exec runner
// ---------------------------------------------------------------------------
class ExecRunner implements SmokeCheckRunner {
  readonly kind = 'exec' as const

  async run(check: SmokeCheck, ctx: SmokeCheckContext): Promise<SmokeCheckResult> {
    if (check.kind !== 'exec') throw new Error('runner kind mismatch')
    const started = Date.now()
    const result: SmokeCheckResult = {
      check,
      ok: false,
      attempt: 1,
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      durationMs: 0,
    }

    const containerName = ctx.containerNameMap[check.container]
    if (!containerName) {
      return finalize(result, started, false, `container ${check.container} not in rehearsal map`)
    }

    try {
      const res = await ctx.docker.execInContainer(containerName, check.command, { timeoutMs: check.timeoutMs ?? 30_000 })
      const expectedExit = check.expectExitCode ?? 0
      if (res.exitCode !== expectedExit) {
        return finalize(
          result, started, false,
          `exit ${res.exitCode}, expected ${expectedExit}: ${truncate(res.stderr || res.stdout, 200)}`
        )
      }
      if (check.stdoutContains && !res.stdout.includes(check.stdoutContains)) {
        return finalize(
          result, started, false,
          `exit ${res.exitCode} but stdout did not contain ${JSON.stringify(check.stdoutContains)}`
        )
      }
      return finalize(result, started, true, `exit ${res.exitCode}`)
    } catch (err: any) {
      return finalize(result, started, false, err?.message || String(err))
    }
  }
}

// ---------------------------------------------------------------------------
// TCP runner
// ---------------------------------------------------------------------------
// We run a tiny exec inside the container with `nc` (or fall back to a bash
// /dev/tcp probe) to avoid any host-network exposure. The runner expects the
// stand-in image to have one of those — every image on this page's recipes
// does. If neither is available the check fails gracefully.
class TcpRunner implements SmokeCheckRunner {
  readonly kind = 'tcp' as const

  async run(check: SmokeCheck, ctx: SmokeCheckContext): Promise<SmokeCheckResult> {
    if (check.kind !== 'tcp') throw new Error('runner kind mismatch')
    const started = Date.now()
    const result: SmokeCheckResult = {
      check,
      ok: false,
      attempt: 1,
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      durationMs: 0,
    }

    const containerName = ctx.containerNameMap[check.container]
    if (!containerName) {
      return finalize(result, started, false, `container ${check.container} not in rehearsal map`)
    }

    const timeoutSec = Math.max(1, Math.ceil((check.timeoutMs ?? 5_000) / 1000))
    // Try nc first, fall back to bash's /dev/tcp pseudo-device.
    const cmd = [
      'sh', '-c',
      `(command -v nc >/dev/null 2>&1 && nc -z -w ${timeoutSec} ${check.container} ${check.port}) ` +
      `|| (exec 3<>/dev/tcp/${check.container}/${check.port}) 2>/dev/null`,
    ]

    try {
      const res = await ctx.docker.execInContainer(containerName, cmd, { timeoutMs: check.timeoutMs ?? 5_000 })
      if (res.exitCode === 0) return finalize(result, started, true, `port ${check.port} open`)
      return finalize(result, started, false, `port ${check.port} closed (exit ${res.exitCode})`)
    } catch (err: any) {
      return finalize(result, started, false, err?.message || String(err))
    }
  }
}

// ---------------------------------------------------------------------------
// file_exists runner
// ---------------------------------------------------------------------------
class FileExistsRunner implements SmokeCheckRunner {
  readonly kind = 'file_exists' as const

  async run(check: SmokeCheck, ctx: SmokeCheckContext): Promise<SmokeCheckResult> {
    if (check.kind !== 'file_exists') throw new Error('runner kind mismatch')
    const started = Date.now()
    const result: SmokeCheckResult = {
      check,
      ok: false,
      attempt: 1,
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      durationMs: 0,
    }

    const containerName = ctx.containerNameMap[check.container]
    if (!containerName) {
      return finalize(result, started, false, `container ${check.container} not in rehearsal map`)
    }

    // `stat` is in coreutils — present in almost every distro. We deliberately
    // use a single shell-quoted path; the path is operator-authored so we
    // don't try to escape arbitrary chars here.
    const minBytes = check.minBytes ?? 1
    const cmd = [
      'sh', '-c',
      `stat -c '%s' '${check.path.replace(/'/g, `'\\''`)}' 2>/dev/null`,
    ]

    try {
      const res = await ctx.docker.execInContainer(containerName, cmd, { timeoutMs: 10_000 })
      if (res.exitCode !== 0) {
        return finalize(result, started, false, `not found: ${check.path}`)
      }
      const size = parseInt(res.stdout.trim(), 10)
      if (Number.isNaN(size)) {
        return finalize(result, started, false, `stat returned non-numeric: ${truncate(res.stdout, 80)}`)
      }
      if (size < minBytes) {
        return finalize(result, started, false, `${check.path} is ${size} bytes, expected >= ${minBytes}`)
      }
      return finalize(result, started, true, `${size} bytes`)
    } catch (err: any) {
      return finalize(result, started, false, err?.message || String(err))
    }
  }
}

// ---------------------------------------------------------------------------
// sql_select_1 runner
// ---------------------------------------------------------------------------
// Pragmatic: we exec the driver's CLI (psql / mysql / sqlcmd) inside the
// stand-in container. That avoids shipping a JS DB driver per dialect and
// keeps the rehearsal stack-agnostic — if the user's container can run its
// own CLI, the check works.
class SqlSelect1Runner implements SmokeCheckRunner {
  readonly kind = 'sql_select_1' as const

  async run(check: SmokeCheck, ctx: SmokeCheckContext): Promise<SmokeCheckResult> {
    if (check.kind !== 'sql_select_1') throw new Error('runner kind mismatch')
    const started = Date.now()
    const result: SmokeCheckResult = {
      check,
      ok: false,
      attempt: 1,
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      durationMs: 0,
    }

    const containerName = ctx.containerNameMap[check.container]
    if (!containerName) {
      return finalize(result, started, false, `container ${check.container} not in rehearsal map`)
    }

    // The query itself is a static `SELECT 1` literal. The shell-built
    // command line is only at risk if any caller-supplied value can break
    // out of its quoting: user/db go through shellArg, and passwordEnv is
    // strictly validated as a POSIX env-var name before being expanded as
    // a shell variable reference. If validation fails we drop the env
    // reference rather than risk command injection.
    if (check.passwordEnv !== undefined && !isPosixEnvVarName(check.passwordEnv)) {
      return finalize(
        result, started, false,
        `passwordEnv must be a POSIX env-var name (matching /^[A-Za-z_][A-Za-z0-9_]*$/), got ${JSON.stringify(check.passwordEnv).slice(0, 40)}`
      )
    }

    let cmd: string[]
    switch (check.driver) {
      case 'postgres': {
        const user = check.user || 'postgres'
        const db = check.db ? `-d ${shellArg(check.db)}` : ''
        const pwexpr = check.passwordEnv ? `PGPASSWORD="$${check.passwordEnv}" ` : ''
        cmd = [
          'sh', '-c',
          `${pwexpr}psql -U ${shellArg(user)} ${db} -tAc 'SELECT 1'`,
        ]
        break
      }
      case 'mysql': {
        const user = check.user || 'root'
        const db = check.db ? shellArg(check.db) : ''
        const pwexpr = check.passwordEnv ? `MYSQL_PWD="$${check.passwordEnv}" ` : ''
        cmd = [
          'sh', '-c',
          `${pwexpr}mysql -u ${shellArg(user)} ${db} -N -B -e 'SELECT 1'`,
        ]
        break
      }
      case 'mssql': {
        const user = check.user || 'sa'
        const pwexpr = check.passwordEnv ? `-P "$${check.passwordEnv}"` : ''
        const db = check.db ? `-d ${shellArg(check.db)}` : ''
        cmd = [
          'sh', '-c',
          `sqlcmd -S localhost -U ${shellArg(user)} ${pwexpr} ${db} -h -1 -W -Q 'SET NOCOUNT ON; SELECT 1'`,
        ]
        break
      }
      default:
        return finalize(result, started, false, `unsupported driver: ${(check as any).driver}`)
    }

    try {
      const res = await ctx.docker.execInContainer(containerName, cmd, { timeoutMs: check.timeoutMs ?? 15_000 })
      if (res.exitCode !== 0) {
        return finalize(result, started, false, `exit ${res.exitCode}: ${truncate(res.stderr || res.stdout, 200)}`)
      }
      if (!/\b1\b/.test(res.stdout)) {
        // Detail string for the report — not a query that ever runs.
        return finalize(result, started, false, `query returned: ${truncate(res.stdout, 80)}`)
      }
      return finalize(result, started, true, 'query returned 1')
    } catch (err: any) {
      return finalize(result, started, false, err?.message || String(err))
    }
  }
}

// ---------------------------------------------------------------------------
// Registry + helpers
// ---------------------------------------------------------------------------

export function createSmokeCheckRegistry(): Map<SmokeCheck['kind'], SmokeCheckRunner> {
  const registry = new Map<SmokeCheck['kind'], SmokeCheckRunner>()
  for (const runner of [
    new HttpRunner(),
    new ExecRunner(),
    new TcpRunner(),
    new FileExistsRunner(),
    new SqlSelect1Runner(),
  ]) {
    registry.set(runner.kind, runner)
  }
  return registry
}

function finalize(
  base: SmokeCheckResult,
  started: number,
  ok: boolean,
  detail?: string
): SmokeCheckResult {
  const end = Date.now()
  return {
    ...base,
    ok,
    detail,
    finishedAt: new Date(end).toISOString(),
    durationMs: end - started,
  }
}

function shellArg(s: string): string {
  if (/^[A-Za-z0-9_.@/-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function truncate(s: string, n: number): string {
  s = (s || '').trim()
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/**
 * POSIX env-var name validator. Used to whitelist `passwordEnv` before it
 * becomes a `$NAME` shell expansion inside the sql_select_1 cmd line.
 * If a request supplies anything else (spaces, quotes, `;`, `$()` etc),
 * the smoke check fails fast rather than risking command injection.
 */
function isPosixEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

// Expose stuff for tests
export const __testables = { matchExpectedStatus, shellArg, truncate, isPosixEnvVarName }

// keep imports used (Node http/net are reserved for a future native-probe
// path that talks to the sandbox network through a forwarded port). Today
// the runners exec inside the stand-in container so we don't expose ports.
void http
void net
