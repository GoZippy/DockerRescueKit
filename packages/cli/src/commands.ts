import { createClient } from './client'

export interface CommandDef {
  name: string
  args: string
  summary: string
  run: (positional: string[], flags: Record<string, string>) => Promise<number>
}

function printJson(data: any): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

function must(value: string | undefined, name: string): string {
  if (!value) {
    process.stderr.write(`missing required argument: ${name}\n`)
    process.exit(2)
  }
  return value
}

export const commands: CommandDef[] = [
  {
    name: 'status',
    args: '',
    summary: 'Service status (uptime, docker connectivity).',
    run: async () => {
      const res = await createClient().get('/status')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'policy:list',
    args: '',
    summary: 'List configured backup policies.',
    run: async () => {
      const res = await createClient().get('/policies')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'policy:show',
    args: '<policyId>',
    summary: 'Show one policy by id.',
    run: async (pos) => {
      const id = must(pos[0], 'policyId')
      const res = await createClient().get(`/policies/${id}`)
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'policy:run',
    args: '<policyId>',
    summary: 'Run a policy immediately.',
    run: async (pos) => {
      const id = must(pos[0], 'policyId')
      const res = await createClient().post(`/policies/${id}/run`)
      printJson(res.data)
      return res.data?.status === 'failed' ? 1 : 0
    }
  },
  {
    name: 'policy:delete',
    args: '<policyId>',
    summary: 'Delete a policy.',
    run: async (pos) => {
      const id = must(pos[0], 'policyId')
      await createClient().delete(`/policies/${id}`)
      return 0
    }
  },
  {
    name: 'backup:list',
    args: '[--policy <policyId>]',
    summary: 'List all backups, or filter by policy.',
    run: async (_pos, flags) => {
      const client = createClient()
      if (flags.policy) {
        const res = await client.get(`/policies/${flags.policy}/history`)
        printJson(res.data)
      } else {
        const res = await client.get('/backups')
        printJson(res.data)
      }
      return 0
    }
  },
  {
    name: 'backup:show',
    args: '<backupId>',
    summary: 'Show one backup record.',
    run: async (pos) => {
      const id = must(pos[0], 'backupId')
      const res = await createClient().get(`/backups/${id}`)
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'backup:restore',
    args: '<backupId> [--dry-run]',
    summary: 'Restore a backup (use --dry-run to verify without writing).',
    run: async (pos, flags) => {
      const id = must(pos[0], 'backupId')
      const res = await createClient().post(`/backups/${id}/restore`, {
        dryRun: flags['dry-run'] === 'true' || flags['dry-run'] === '' || 'dry-run' in flags
      })
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'backup:verify',
    args: '<backupId>',
    summary: 'Scratch-restore the backup to prove it is restorable.',
    run: async (pos) => {
      const id = must(pos[0], 'backupId')
      const res = await createClient().post(`/backups/${id}/verify`)
      printJson(res.data)
      return res.data?.ok ? 0 : 1
    }
  },
  {
    name: 'backup:delete',
    args: '<backupId>',
    summary: 'Delete a backup from storage and DB.',
    run: async (pos) => {
      const id = must(pos[0], 'backupId')
      await createClient().delete(`/backups/${id}`)
      return 0
    }
  },
  {
    name: 'stacks',
    args: '',
    summary: 'List compose stacks detected on this host.',
    run: async () => {
      const res = await createClient().get('/docker/stacks')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'volumes',
    args: '',
    summary: 'List Docker volumes.',
    run: async () => {
      const res = await createClient().get('/docker/volumes')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'stack:protect',
    args: '<project>',
    summary: 'Create a daily protection policy for a compose stack.',
    run: async (pos) => {
      const project = must(pos[0], 'project')
      const res = await createClient().post(`/docker/stacks/${encodeURIComponent(project)}/protect`)
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'verify:history',
    args: '[--backup <backupId>]',
    summary: 'Show verify run history, optionally scoped to a backup.',
    run: async (_pos, flags) => {
      const client = createClient()
      const url = flags.backup ? `/backups/${flags.backup}/verify-history` : '/verify-history'
      const res = await client.get(url)
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'connectors:list',
    args: '',
    summary: 'List saved connector instances.',
    run: async () => {
      const res = await createClient().get('/connectors')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'connectors:definitions',
    args: '',
    summary: 'List available connector definitions and their fields.',
    run: async () => {
      const res = await createClient().get('/connectors/definitions')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'connectors:test',
    args: '<type> --config <json>',
    summary: 'Test an inline connector config without saving it.',
    run: async (pos, flags) => {
      const type = must(pos[0], 'type')
      const cfgStr = must(flags.config, '--config')
      let config: any
      try { config = JSON.parse(cfgStr) } catch {
        process.stderr.write('--config must be valid JSON\n'); return 2
      }
      const res = await createClient().post('/connectors/test', { type, config })
      printJson(res.data)
      return res.data?.success ? 0 : 1
    }
  },
  {
    name: 'audit',
    args: '',
    summary: 'Print the audit log.',
    run: async () => {
      const res = await createClient().get('/audit')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'settings:show',
    args: '',
    summary: 'Show runtime metadata (dataDir, version, staging).',
    run: async () => {
      const res = await createClient().get('/settings/meta')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'images',
    args: '',
    summary: 'List Docker images.',
    run: async () => {
      const res = await createClient().get('/docker/images')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'networks',
    args: '',
    summary: 'List Docker networks.',
    run: async () => {
      const res = await createClient().get('/docker/networks')
      printJson(res.data)
      return 0
    }
  },

  // ── Scheduler ──────────────────────────────────────────────────────────────
  {
    name: 'scheduler:pause',
    args: '',
    summary: 'Pause all scheduled jobs.',
    run: async () => {
      const res = await createClient().post('/scheduler/pause')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'scheduler:resume',
    args: '',
    summary: 'Resume all scheduled jobs.',
    run: async () => {
      const res = await createClient().post('/scheduler/resume')
      printJson(res.data)
      return 0
    }
  },

  // ── Rclone ─────────────────────────────────────────────────────────────────
  {
    name: 'rclone:providers',
    args: '',
    summary: 'List supported rclone provider types.',
    run: async () => {
      const res = await createClient().get('/rclone/providers')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'rclone:list',
    args: '',
    summary: 'List configured rclone remotes.',
    run: async () => {
      const res = await createClient().get('/rclone/remotes')
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'rclone:add',
    args: '<name> <providerType> [--params <json>]',
    summary: 'Add a new rclone remote.',
    run: async (pos, flags) => {
      const name = must(pos[0], 'name')
      const providerType = must(pos[1], 'providerType')
      let params: any = {}
      if (flags.params) {
        try { params = JSON.parse(flags.params) } catch {
          process.stderr.write('--params must be valid JSON\n'); return 2
        }
      }
      const res = await createClient().post('/rclone/remotes', { name, providerType, params })
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'rclone:delete',
    args: '<name>',
    summary: 'Delete a configured rclone remote.',
    run: async (pos) => {
      const name = must(pos[0], 'name')
      await createClient().delete(`/rclone/remotes/${encodeURIComponent(name)}`)
      return 0
    }
  },
  {
    name: 'rclone:test',
    args: '<name>',
    summary: 'Test a rclone remote connection.',
    run: async (pos) => {
      const name = must(pos[0], 'name')
      const res = await createClient().post(`/rclone/remotes/${encodeURIComponent(name)}/test`)
      printJson(res.data)
      return res.data?.ok ? 0 : 1
    }
  },

  // ── Backup extras ──────────────────────────────────────────────────────────
  {
    name: 'backup:files',
    args: '<backupId> <fileName>',
    summary: 'Browse files inside a backup archive.',
    run: async (pos) => {
      const id = must(pos[0], 'backupId')
      const fileName = must(pos[1], 'fileName')
      const res = await createClient().get(`/backups/${id}/files`, {
        params: { name: fileName }
      })
      printJson(res.data)
      return 0
    }
  },

  // ── Connectors extras ──────────────────────────────────────────────────────
  {
    name: 'connectors:delete',
    args: '<id>',
    summary: 'Delete a saved connector instance.',
    run: async (pos) => {
      const id = must(pos[0], 'id')
      await createClient().delete(`/connectors/${id}`)
      return 0
    }
  },

  // ── Policy extras ──────────────────────────────────────────────────────────
  {
    name: 'policy:history',
    args: '<policyId>',
    summary: 'List backup history for a policy.',
    run: async (pos) => {
      const id = must(pos[0], 'policyId')
      const res = await createClient().get(`/policies/${id}/history`)
      printJson(res.data)
      return 0
    }
  },

  // ── Rehearsals (R-1) ───────────────────────────────────────────────────────
  // Restore-rehearsal workflow: spin up a sandboxed network, restore selected
  // backups, run smoke checks, tear down. The CLI surface mirrors the REST
  // endpoints in packages/backend/src/routes/rehearsals.ts so anything you
  // can do from the UI you can also script.
  {
    name: 'rehearsal:start',
    args: '<--policy <id> | --backup <id> [--backup <id>...]> --check <kind:container[:opt=val,...]>... [--no-stop-on-fail] [--subnet <cidr>] [--timeout-ms <n>] [--allow-env <NAME>...]',
    summary: 'Enqueue a new restore rehearsal. Returns the new rehearsal id; track with rehearsal:show.',
    run: async (_pos, flags) => {
      const body: any = {
        smokeChecks: parseSmokeChecks(flags.check),
        options: {},
      }
      if (flags.policy) body.policyId = flags.policy
      if (flags.backup) {
        body.backupIds = Array.isArray(flags.backup) ? flags.backup : [flags.backup]
      }
      if (!body.policyId && !body.backupIds) {
        process.stderr.write('rehearsal:start needs --policy <id> or --backup <id>\n')
        return 2
      }
      if (body.smokeChecks.length === 0) {
        process.stderr.write('rehearsal:start needs at least one --check\n')
        return 2
      }
      if ('no-stop-on-fail' in flags) body.options.stopOnFirstCheckFailure = false
      if (flags.subnet) body.options.networkSubnet = flags.subnet
      if (flags['timeout-ms']) body.options.timeoutMs = parseInt(flags['timeout-ms'], 10)
      if (flags['allow-env']) {
        body.options.allowEnvVars = Array.isArray(flags['allow-env'])
          ? flags['allow-env']
          : [flags['allow-env']]
      }
      const res = await createClient().post('/rehearsals', body)
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'rehearsal:list',
    args: '[--policy <id>] [--limit <n>]',
    summary: 'List recent rehearsal runs.',
    run: async (_pos, flags) => {
      const qs: string[] = []
      if (flags.policy) qs.push(`policyId=${encodeURIComponent(flags.policy)}`)
      if (flags.limit) qs.push(`limit=${encodeURIComponent(flags.limit)}`)
      const path = `/rehearsals${qs.length ? '?' + qs.join('&') : ''}`
      const res = await createClient().get(path)
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'rehearsal:show',
    args: '<rehearsalId>',
    summary: 'Fetch the full RehearsalReport (steps, smoke-check results, resources).',
    run: async (pos) => {
      const id = must(pos[0], 'rehearsalId')
      const res = await createClient().get(`/rehearsals/${id}`)
      printJson(res.data)
      return res.data?.ok ? 0 : 1
    }
  },
  {
    name: 'rehearsal:abort',
    args: '<rehearsalId>',
    summary: 'Signal cancel for an active rehearsal. Teardown still runs.',
    run: async (pos) => {
      const id = must(pos[0], 'rehearsalId')
      const res = await createClient().post(`/rehearsals/${id}/abort`)
      printJson(res.data)
      return 0
    }
  },
  {
    name: 'rehearsal:delete',
    args: '<rehearsalId>',
    summary: 'Drop the persisted record. Does NOT teardown resources (lifecycle owns that).',
    run: async (pos) => {
      const id = must(pos[0], 'rehearsalId')
      await createClient().delete(`/rehearsals/${id}`)
      return 0
    }
  }
]

/**
 * Parse `--check kind:container[:k=v,k=v,...]` flag values into the
 * SmokeCheck JSON shape expected by POST /api/rehearsals.
 *
 * Examples:
 *   --check tcp:app:port=80
 *   --check http:nginx:port=80,path=/health,expectStatus=200
 *   --check sql_select_1:db:driver=postgres,user=postgres,passwordEnv=POSTGRES_PASSWORD
 *   --check file_exists:vault:path=/data/db.sqlite3,minBytes=1024
 *   --check exec:app:command=ls /data
 *
 * Repeat the flag to add multiple checks. The runtime validator on the
 * server side enforces per-kind required fields; this parser only does
 * shape coercion (numeric / boolean / array).
 */
function parseSmokeChecks(raw: string | string[] | undefined): any[] {
  if (!raw) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  return arr.map(token => {
    const parts = token.split(':')
    if (parts.length < 2) {
      process.stderr.write(`bad --check value: ${token} (expected kind:container[:k=v,...])\n`)
      process.exit(2)
    }
    const [kind, container, ...rest] = parts
    const opts = rest.join(':') // permits colons inside values (e.g. URLs)
    const check: any = { kind, container }
    if (opts) {
      for (const pair of opts.split(',')) {
        const eq = pair.indexOf('=')
        if (eq <= 0) continue
        const k = pair.slice(0, eq).trim()
        let v: any = pair.slice(eq + 1).trim()
        // shape coercion: numeric, boolean, JSON-array for `command`
        if (k === 'command') {
          // `command=ls /data` splits on whitespace; quote-handling
          // is out of scope — for complex argvs, build via REST directly.
          v = String(v).split(/\s+/)
        } else if (/^\d+$/.test(v)) {
          v = parseInt(v, 10)
        } else if (v === 'true' || v === 'false') {
          v = v === 'true'
        }
        check[k] = v
      }
    }
    return check
  })
}

export function findCommand(name: string): CommandDef | undefined {
  return commands.find(c => c.name === name)
}
