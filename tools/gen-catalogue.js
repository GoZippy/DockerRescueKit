#!/usr/bin/env node
/**
 * Generate host-side copies of the Docker fatal-error catalogue.
 *
 * WHY: `drk doctor` runs on the host, where Node may not be installed. The host
 * artifacts are therefore a POSIX shell script (macOS/Linux) and a PowerShell
 * data file (Windows), shipped via metadata.json `host.binaries`. Both need the
 * pattern table that packages/shared/src/dockerFatalErrors.ts defines.
 *
 * Duplicated pattern tables drift, and a drifted table produces a confidently
 * wrong diagnosis — the exact failure mode this whole feature exists to fix. So
 * the TypeScript module is the single source of truth and these are generated.
 *
 * The shell output is SELF-CONTAINED: the catalogue is inlined into the script
 * rather than dot-sourced from a sibling file. Docker Desktop's `host.binaries`
 * copies the declared files onto the host; it does not promise to bring sibling
 * directories along, and a doctor that dies on a missing include is worse than
 * useless — it fails at exactly the moment it is needed.
 *
 * Reads the COMPILED module, so build shared first:
 *   npm run build --workspace=@docker-rescue-kit/shared
 *
 * Usage: node tools/gen-catalogue.js
 */

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const COMPILED = path.join(REPO_ROOT, 'packages', 'shared', 'dist', 'dockerFatalErrors.js')
const TEMPLATE = path.join(REPO_ROOT, 'host', 'drk-doctor.template.sh')
const OUT_DIR = path.join(REPO_ROOT, 'host', 'generated')

const BANNER = [
  'GENERATED FILE — DO NOT EDIT.',
  'Source: packages/shared/src/dockerFatalErrors.ts',
  'Regenerate: npm run gen:catalogue'
]

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

if (!fs.existsSync(COMPILED)) {
  fail(
    `${COMPILED} not found.\n` +
      'Build the shared package first:\n' +
      '  npm run build --workspace=@docker-rescue-kit/shared'
  )
}
if (!fs.existsSync(TEMPLATE)) fail(`${TEMPLATE} not found.`)

const { DOCKER_FATAL_ERROR_PATTERNS, KNOWN_DECOY_PATTERNS } = require(COMPILED)

if (!Array.isArray(DOCKER_FATAL_ERROR_PATTERNS) || DOCKER_FATAL_ERROR_PATTERNS.length === 0) {
  fail('catalogue is empty — refusing to generate.')
}

/* ------------------------------------------------------------------ */
/* ERE compatibility gate                                              */
/* ------------------------------------------------------------------ */

/**
 * POSIX ERE cannot express these, and BSD grep (macOS) treats the shorthand
 * classes as literals rather than erroring — which fails silently, the worst
 * outcome. Refuse to generate rather than ship a table that quietly mismatches.
 */
const ERE_VIOLATIONS = [
  { probe: /\(\?:/, why: 'non-capturing group (?: — use a plain group' },
  { probe: /\(\?[=!]/, why: 'lookahead — no ERE equivalent' },
  { probe: /\(\?<[=!]/, why: 'lookbehind — no ERE equivalent' },
  { probe: /[+*?]\?/, why: 'lazy quantifier — use a negated character class' },
  { probe: /\\[dwsSDW]/, why: 'shorthand class (\\d \\w \\s ...) — BSD grep treats it as a literal' }
]

function assertEreSafe(label, source) {
  // Named groups are fine — stripNamedGroups removes them below.
  const stripped = source.replace(/\(\?<[A-Za-z_][A-Za-z0-9_]*>/g, '(')
  for (const { probe, why } of ERE_VIOLATIONS) {
    if (probe.test(stripped)) {
      fail(
        `pattern "${label}" is not ERE-safe: ${why}\n` +
          `  source: ${source}\n` +
          '  See the PORTABILITY CONSTRAINT block in dockerFatalErrors.ts.'
      )
    }
  }
  return stripped
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function assertNoTabs(label, fields) {
  for (const field of fields) {
    if (String(field).includes('\t')) {
      fail(`catalogue field for "${label}" contains a tab, which breaks the record encoding`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Build the tables                                                    */
/* ------------------------------------------------------------------ */

// Every current pattern is case-insensitive. Rather than encode a per-record
// flag the shell would have to branch on, assert the invariant and let the
// script use `grep -Ei` unconditionally.
for (const entry of DOCKER_FATAL_ERROR_PATTERNS) {
  if (!entry.pattern.flags.includes('i')) {
    fail(
      `pattern "${entry.code}" is case-SENSITIVE. The shell catalogue matches with ` +
        'grep -Ei for all records. Either add the i flag or teach the generator ' +
        'and drk-doctor.template.sh to carry the flag per record.'
    )
  }
}

const fatalRecords = DOCKER_FATAL_ERROR_PATTERNS.map(entry => {
  const ere = assertEreSafe(entry.code, entry.pattern.source)
  const fields = [entry.code, ere, entry.title, entry.recommendation]
  assertNoTabs(entry.code, fields)
  return fields.join('\t')
})

const decoyRecords = (KNOWN_DECOY_PATTERNS || []).map((decoy, index) => {
  const ere = assertEreSafe(`decoy#${index}`, decoy.pattern.source)
  const fields = [ere, decoy.note]
  assertNoTabs(`decoy#${index}`, fields)
  return fields.join('\t')
})

/* ------------------------------------------------------------------ */
/* Emit                                                                */
/* ------------------------------------------------------------------ */

function generatePowerShell() {
  const lines = BANNER.map(line => `# ${line}`)
  lines.push('')
  lines.push('$script:DrkFatalPatterns = @(')
  for (const entry of DOCKER_FATAL_ERROR_PATTERNS) {
    lines.push('    [PSCustomObject]@{')
    lines.push(`        Code           = ${psQuote(entry.code)}`)
    lines.push(`        Title          = ${psQuote(entry.title)}`)
    lines.push(`        Pattern        = ${psQuote(entry.pattern.source)}`)
    lines.push(`        Recommendation = ${psQuote(entry.recommendation)}`)
    lines.push(`        Repairable     = $${entry.repairable ? 'true' : 'false'}`)
    lines.push(`        RepairImpact   = ${psQuote(entry.repairImpact || '')}`)
    lines.push('    }')
  }
  lines.push(')')
  lines.push('')
  lines.push('$script:DrkDecoyPatterns = @(')
  for (const decoy of KNOWN_DECOY_PATTERNS || []) {
    lines.push('    [PSCustomObject]@{')
    lines.push(`        Pattern = ${psQuote(decoy.pattern.source)}`)
    lines.push(`        Note    = ${psQuote(decoy.note)}`)
    lines.push('    }')
  }
  lines.push(')')
  lines.push('')
  return lines.join('\n')
}

function generateShell() {
  const template = fs.readFileSync(TEMPLATE, 'utf8')
  const placeholder = '#__DRK_CATALOGUE__'
  if (!template.includes(placeholder)) {
    fail(`${TEMPLATE} is missing the ${placeholder} placeholder.`)
  }

  const block = [
    BANNER.map(line => `# ${line}`).join('\n'),
    '',
    '# TAB-delimited: code<TAB>ere<TAB>title<TAB>recommendation',
    'DRK_FATAL_PATTERNS=' + shQuote(fatalRecords.join('\n')),
    '',
    '# TAB-delimited: ere<TAB>note',
    'DRK_DECOY_PATTERNS=' + shQuote(decoyRecords.join('\n'))
  ].join('\n')

  return template.replace(placeholder, block)
}

fs.mkdirSync(OUT_DIR, { recursive: true })

const psPath = path.join(OUT_DIR, 'drk-catalogue.ps1')
const shPath = path.join(OUT_DIR, 'drk-doctor.sh')

fs.writeFileSync(psPath, generatePowerShell(), 'utf8')
fs.writeFileSync(shPath, generateShell(), { encoding: 'utf8', mode: 0o755 })

process.stdout.write(
  `generated ${fatalRecords.length} patterns + ${decoyRecords.length} decoys\n` +
    `  ${path.relative(REPO_ROOT, psPath)}\n` +
    `  ${path.relative(REPO_ROOT, shPath)} (self-contained)\n`
)
