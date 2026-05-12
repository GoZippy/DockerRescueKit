#!/usr/bin/env node
import { commands, findCommand } from './commands'

interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string> = {}

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=')
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1)
      } else {
        const next = rest[i + 1]
        if (next && !next.startsWith('--')) {
          flags[tok.slice(2)] = next
          i++
        } else {
          flags[tok.slice(2)] = ''
        }
      }
    } else {
      positional.push(tok)
    }
  }

  return { command: command || '', positional, flags }
}

const BOLD_BLUE = '\x1b[1;34m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const GROUPS: { label: string; names: string[] }[] = [
  {
    label: 'Service',
    names: ['status', 'scheduler:pause', 'scheduler:resume']
  },
  {
    label: 'Policies',
    names: ['policy:list', 'policy:show', 'policy:run', 'policy:delete', 'policy:history']
  },
  {
    label: 'Backups',
    names: ['backup:list', 'backup:show', 'backup:restore', 'backup:verify', 'backup:delete', 'backup:files']
  },
  {
    label: 'Docker',
    names: ['stacks', 'volumes', 'images', 'networks', 'stack:protect']
  },
  {
    label: 'Connectors',
    names: ['connectors:list', 'connectors:definitions', 'connectors:test', 'connectors:delete']
  },
  {
    label: 'Rclone',
    names: ['rclone:providers', 'rclone:list', 'rclone:add', 'rclone:delete', 'rclone:test']
  },
  {
    label: 'Audit & Settings',
    names: ['audit', 'settings:show', 'verify:history']
  }
]

function printHelp(): void {
  const out: string[] = [
    `${BOLD_BLUE}drk${RESET} — Docker Rescue Kit CLI`,
    '',
    `${DIM}Usage:${RESET}  drk <command> [arguments] [--flags]`,
    '',
    `${DIM}Environment:${RESET}`,
    '  DRK_URL       API base URL (default: http://localhost:42880)',
    '  DRK_API_KEY   API key (required)',
    ''
  ]

  // Build a lookup map from command name → CommandDef
  const byName = new Map(commands.map(c => [c.name, c]))

  // Determine column width across all commands
  const cmdColWidth = Math.max(
    ...commands.map(c => `${c.name} ${c.args}`.trim().length)
  ) + 2

  for (const group of GROUPS) {
    out.push(`${BOLD_BLUE}${group.label}${RESET}`)
    for (const name of group.names) {
      const c = byName.get(name)
      if (!c) continue
      const left = `${c.name} ${c.args}`.trim()
      out.push(`  ${left.padEnd(cmdColWidth)} ${DIM}${c.summary}${RESET}`)
    }
    out.push('')
  }

  process.stdout.write(out.join('\n') + '\n')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printHelp()
    process.exit(0)
  }

  const parsed = parseArgs(argv)
  const cmd = findCommand(parsed.command)
  if (!cmd) {
    process.stderr.write(`unknown command: ${parsed.command}\n\n`)
    printHelp()
    process.exit(2)
  }

  try {
    const code = await cmd.run(parsed.positional, parsed.flags)
    process.exit(code)
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || String(err)
    process.stderr.write(`error: ${msg}\n`)
    process.exit(1)
  }
}

main()
