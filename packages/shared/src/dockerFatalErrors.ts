/**
 * Catalogue of fatal Docker daemon startup failures.
 *
 * WHY THIS EXISTS
 *
 * When `dockerd` fails to start, Docker Desktop surfaces a dialog reading
 * "An unexpected error occurred" with a single error string. That string is
 * frequently NOT the fatal error — it is whichever non-fatal warning or error
 * the daemon happened to log last before exiting.
 *
 * Observed on Docker Desktop 4.84.0 and 4.87.0 (Windows/WSL2): a stale entry in
 * libnetwork's key-value store owned the `docker0` bridge name, so the daemon
 * could not create the default bridge network and exited 1. The dialog reported
 * `enable fsverity failed: operation not supported` — a warning-level capability
 * probe logged 7.3 seconds earlier against `/var/lib/docker/plugins/storage`,
 * entirely unrelated to the failure. On 4.84.0 the same underlying fault was
 * reported as an unrelated `config.v2.json: no such file or directory`.
 *
 * The real error is present, but only in the VM-side init log, at `info` level:
 *
 *   {"component":"command","error":"failed to start daemon: ...","level":"info",
 *    "msg":"Daemon shutdown complete"}
 *
 * So: read the log, not the dialog.
 *
 * DESIGN
 *
 * `GENERIC_DAEMON_FAILURE` is the workhorse — it matches any
 * `failed to start daemon: <reason>` line and is what makes this useful for
 * failures nobody has catalogued yet. The specific entries above it exist to
 * add a repair path and a better recommendation for faults DRK can actually
 * fix. Specific patterns are tried first; the generic one is the fallback.
 *
 * Adding an entry is cheap. Only add patterns you have seen in a real log —
 * a wrong regex here produces a confidently wrong diagnosis, which is worse
 * than no diagnosis.
 *
 * PORTABILITY CONSTRAINT — READ BEFORE ADDING A PATTERN
 *
 * These patterns are transpiled to POSIX ERE for the shell host script by
 * tools/gen-catalogue.js, so they must stay inside the ERE-expressible subset:
 *
 *   - no non-capturing groups `(?:...)`     — use a plain group
 *   - no lazy quantifiers `+?` `*?` `??`    — use a negated character class
 *   - no lookaround `(?=` `(?!` `(?<=`      — no equivalent exists
 *   - no shorthand classes `\d \w \s \S`    — BSD grep treats these as literals
 *   - named groups `(?<name>...)` ARE fine  — the generator strips them
 *
 * The generator hard-fails if a pattern violates this, so a PCRE-only pattern
 * cannot silently ship a broken shell catalogue.
 */

export type DockerFatalErrorSeverity = 'critical'

export interface DockerFatalErrorPattern {
  /** Stable identifier, also used as the rescue-report finding code. */
  code: string
  title: string
  severity: DockerFatalErrorSeverity
  /**
   * Applied per log line. Use named capture groups; they are passed to
   * `describe()` and surfaced on the match for repair tooling.
   */
  pattern: RegExp
  describe: (groups: Record<string, string>) => string
  recommendation: string
  /** Whether DRK can repair this without a Docker factory reset. */
  repairable: boolean
  /** Short note on what the repair costs the user. */
  repairImpact?: string
}

export interface DockerFatalErrorMatch {
  code: string
  title: string
  severity: DockerFatalErrorSeverity
  detail: string
  recommendation: string
  repairable: boolean
  repairImpact?: string
  /** Named capture groups from the matching pattern. */
  groups: Record<string, string>
  /** The raw log line, trimmed. */
  line: string
  /** ISO timestamp parsed from the line's `"time"` field, when present. */
  timestamp?: string
}

/**
 * Non-fatal messages that Docker Desktop is known to misreport as the cause of
 * a startup failure. When one of these is showing in the UI, it is almost
 * certainly a decoy and the real error is elsewhere in the log.
 */
export const KNOWN_DECOY_PATTERNS: Array<{ pattern: RegExp; note: string }> = [
  {
    pattern: /enable fsverity failed: operation not supported/i,
    note:
      'A warning-level fs-verity capability probe against /var/lib/docker/plugins/storage. ' +
      'The daemon continues normally after logging it. Not a cause of startup failure.'
  },
  {
    pattern: /config\.v2\.json: no such file or directory/i,
    note:
      'An error-level "Failed to load container" entry during container restore. ' +
      'The daemon continues past it. Indicates one unreadable container record, not a startup blocker.'
  },
  {
    pattern: /running nft: .*Could not process rule: No such file or directory/i,
    note:
      'nftables teardown of a table that was not present. Logged at info level on most starts. Harmless.'
  }
]

export const DOCKER_FATAL_ERROR_PATTERNS: DockerFatalErrorPattern[] = [
  {
    code: 'DUPLICATE_BRIDGE_NETWORK',
    title: 'A stale network already owns the default bridge name',
    severity: 'critical',
    pattern:
      /cannot create network (?<attempted>[0-9a-f]{12,64}) \((?<bridge>[^)]+)\): conflicts with network (?<conflict>[0-9a-f]{12,64})/i,
    describe: g =>
      `The daemon could not create the default "${g.bridge}" network because network ${g.conflict} ` +
      `already claims that bridge name. Every start attempt fails identically; the store does not self-heal.`,
    recommendation:
      'Clear libnetwork\'s key-value store with the engine stopped, then restore network definitions ' +
      'from the most recent snapshot.',
    repairable: true,
    repairImpact:
      'Erases user-defined networks. Images, containers and volumes are untouched; ' +
      'compose recreates its networks on the next up.'
  },
  {
    code: 'ADDRESS_POOL_EXHAUSTED',
    title: 'No non-overlapping address pool available for the default network',
    severity: 'critical',
    pattern:
      /could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network/i,
    describe: () =>
      'The daemon ran out of usable private address space for the default bridge, usually because a large ' +
      'number of user-defined networks are still defined, or a host route overlaps Docker\'s default pools.',
    recommendation:
      'Remove unused networks, or configure explicit default-address-pools in daemon.json.',
    repairable: true,
    repairImpact:
      'Removing unused networks affects only networks; containers must be reattached or recreated by compose.'
  },
  {
    code: 'GRAPHDRIVER_INIT_FAILED',
    title: 'Storage driver failed to initialise',
    severity: 'critical',
    pattern: /error initializing graphdriver:? *(?<reason>[^"]*)/i,
    describe: g => {
      const reason = (g.reason || '').trim()
      return (
        `The configured storage driver could not start${reason ? `: ${reason}.` : '.'} ` +
        'This usually means the layer store was written by a different driver, or the backing filesystem changed.'
      )
    },
    recommendation:
      'Do not clear the layer store blind — that destroys all images. Capture a diagnostics bundle and ' +
      'confirm which driver the existing data was written with before changing anything.',
    repairable: false
  },
  {
    code: 'DAEMON_PID_PRESENT',
    title: 'A stale daemon pid file is blocking startup',
    severity: 'critical',
    // `[^ "]+` rather than `\S+`: BSD grep -E treats `\S` as a literal S.
    pattern: /pid file found, ensure docker is not running or delete (?<pidfile>[^ "]+)/i,
    describe: g =>
      `A previous daemon left ${g.pidfile} behind, typically after a hard kill. The new daemon refuses ` +
      'to start while it exists.',
    recommendation: 'Confirm no dockerd process is running, then remove the stale pid file.',
    repairable: true,
    repairImpact: 'Removes a single lock file. No data is affected.'
  },
  {
    // Fallback. Must stay last — the specific patterns above are tried first.
    code: 'GENERIC_DAEMON_FAILURE',
    title: 'Docker daemon failed to start',
    severity: 'critical',
    // The reason sits inside a JSON string field, so the terminator is an
    // UNESCAPED quote. A lazy `.+?` stops at the first `"` it sees, which on the
    // canonical bridge-conflict line is the escaped quote in `\"bridge\"` — that
    // truncates the diagnosis mid-sentence and drops the actual cause.
    // `(\\.|[^"\\])+` consumes escape pairs whole and stops only at a real quote.
    pattern: /failed to start daemon: (?<reason>(\\.|[^"\\])+)/i,
    describe: g => unescapeJsonFragment(g.reason || '').trim(),
    recommendation:
      'This failure is not in DRK\'s catalogue yet. The message above is the daemon\'s own fatal error and ' +
      'is more reliable than the Docker Desktop dialog. Capture a diagnostics bundle before changing anything.',
    repairable: false
  }
]

/**
 * Undo JSON string escaping on a fragment lifted out of a log line by regex.
 * The daemon's messages routinely contain `\"quoted\"` terms, which read badly
 * if surfaced raw.
 */
export function unescapeJsonFragment(text: string): string {
  return text.replace(/\\(["\\/])/g, '$1').replace(/\\n/g, ' ').replace(/\\t/g, ' ')
}

/** Pull the ISO timestamp out of a JSON log line, if it has one. */
export function parseLogTimestamp(line: string): string | undefined {
  const match = /"time":"([^"]+)"/.exec(line)
  return match ? match[1] : undefined
}

/**
 * Match a single log line against the catalogue. Specific patterns win over
 * the generic fallback. Returns null when nothing matches.
 */
export function matchDockerFatalError(line: string): DockerFatalErrorMatch | null {
  for (const entry of DOCKER_FATAL_ERROR_PATTERNS) {
    const result = entry.pattern.exec(line)
    if (!result) continue

    const groups: Record<string, string> = {}
    if (result.groups) {
      for (const [key, value] of Object.entries(result.groups)) {
        if (typeof value === 'string') groups[key] = value
      }
    }

    return {
      code: entry.code,
      title: entry.title,
      severity: entry.severity,
      detail: entry.describe(groups),
      recommendation: entry.recommendation,
      repairable: entry.repairable,
      repairImpact: entry.repairImpact,
      groups,
      line: line.trim(),
      timestamp: parseLogTimestamp(line)
    }
  }
  return null
}

/**
 * Scan log lines newest-relevant-first. Returns at most one match per code —
 * the last occurrence — because a daemon that retries logs the same fatal error
 * repeatedly and the newest one reflects current state.
 *
 * Ordering of the result follows catalogue order, so a specific, repairable
 * finding is never buried under the generic fallback.
 */
export function scanDockerFatalErrors(lines: string[]): DockerFatalErrorMatch[] {
  const byCode = new Map<string, DockerFatalErrorMatch>()
  for (const line of lines) {
    const match = matchDockerFatalError(line)
    if (match) byCode.set(match.code, match)
  }

  const ordered: DockerFatalErrorMatch[] = []
  for (const entry of DOCKER_FATAL_ERROR_PATTERNS) {
    const match = byCode.get(entry.code)
    if (match) ordered.push(match)
  }
  return ordered
}

/**
 * Identify a message the user is being shown that is a known decoy. Use this to
 * tell the user, in as many words, that the dialog is pointing at the wrong
 * thing — otherwise they will keep investigating it.
 */
export function findDecoy(message: string): { pattern: RegExp; note: string } | null {
  if (!message) return null
  return KNOWN_DECOY_PATTERNS.find(decoy => decoy.pattern.test(message)) || null
}
