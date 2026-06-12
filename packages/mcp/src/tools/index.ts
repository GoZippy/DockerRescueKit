import type { GuardEvent, GuardOpKind } from '@docker-rescue-kit/shared'
import type { DrkGuardClient } from '../drkClient'
import type { DockerOps, PruneScope } from '../docker'

/**
 * Tool implementations for the drk-mcp server. Each is a plain async function
 * over the two clients so the test suite can assert the exact sequence of
 * calls (snapshot STRICTLY before prune) against mocks.
 *
 * Every tool returns BOTH a human-readable summary string and the structured
 * JSON the agent reasons over.
 */

export interface ToolDeps {
  drk: DrkGuardClient
  docker: DockerOps
}

export interface ToolResult<T = unknown> {
  text: string
  structured: T
}

const PRUNE_KIND: Record<PruneScope, GuardOpKind> = {
  system: 'system_prune',
  volumes: 'volume_prune',
  images: 'image_prune',
  containers: 'container_rm_v',
}

// ---------------------------------------------------------------------------
// list_guard_snapshots
// ---------------------------------------------------------------------------
export async function listGuardSnapshots(deps: ToolDeps): Promise<ToolResult<GuardEvent[]>> {
  const events = await deps.drk.listEvents({ limit: 20 })
  const text =
    events.length === 0
      ? 'No guard snapshots recorded yet.'
      : `Found ${events.length} recent guard snapshot event(s):\n` +
        events
          .map(
            e =>
              `- ${e.id} [${e.kind}] ${e.status} — ${e.volumes.length} volume(s), ${fmtBytes(e.totalBytes)} at ${e.createdAt}`,
          )
          .join('\n')
  return { text, structured: events }
}

// ---------------------------------------------------------------------------
// snapshot_volumes
// ---------------------------------------------------------------------------
export async function snapshotVolumes(
  deps: ToolDeps,
  args: { volumes: string[] },
): Promise<ToolResult<GuardEvent>> {
  const volumes = normalizeVolumes(args.volumes)
  if (volumes.length === 0) throw new Error('snapshot_volumes requires at least one volume name.')
  const event = await deps.drk.snapshotNow(volumes, 'periodic_floor')
  const saved = event.volumes.filter(v => v.status === 'saved').map(v => v.volume)
  const skipped = event.volumes.filter(v => v.status !== 'saved')
  const text =
    `Guard snapshot ${event.id} (${event.status}). Saved ${saved.length}/${event.volumes.length} volume(s).` +
    (skipped.length ? ` Skipped/failed: ${skipped.map(s => `${s.volume} (${s.status})`).join(', ')}.` : '')
  return { text, structured: event }
}

// ---------------------------------------------------------------------------
// safe_prune — snapshot-then-act
// ---------------------------------------------------------------------------
export interface SafePruneResult {
  scope: PruneScope
  snapshotted: string[]
  skipped: string[]
  warnings: string[]
  guardEventId: string | null
  pruned: unknown
}

export async function safePrune(
  deps: ToolDeps,
  args: { scope: PruneScope; volumes?: string[] },
): Promise<ToolResult<SafePruneResult>> {
  const scope = args.scope
  const warnings: string[] = []
  let snapshotted: string[] = []
  let skipped: string[] = []
  let guardEventId: string | null = null

  // STEP 1 — snapshot the in-scope volumes FIRST (the whole point of the tool).
  const targets = normalizeVolumes(args.volumes || [])
  if (scope === 'volumes' || scope === 'system') {
    try {
      const event = await deps.drk.snapshotNow(targets, PRUNE_KIND[scope])
      guardEventId = event.id
      snapshotted = event.volumes.filter(v => v.status === 'saved').map(v => v.volume)
      skipped = event.volumes.filter(v => v.status !== 'saved').map(v => v.volume)
      for (const s of event.volumes.filter(v => v.status !== 'saved')) {
        warnings.push(`Volume "${s.volume}" was not snapshotted (${s.status}${s.detail ? `: ${s.detail}` : ''}).`)
      }
    } catch (err: any) {
      // FAIL-OPEN (§7.1): the prune still proceeds, but the agent is warned
      // prominently so it can decide whether to abort.
      warnings.push(
        `WARNING: guard snapshot FAILED before prune (${err?.message || err}). ` +
          'Proceeding fail-open per Prune Guard policy — data destroyed by this prune may NOT be recoverable.',
      )
    }
  }

  // STEP 2 — only now perform the actual prune against the daemon.
  const pruned = await deps.docker.prune(scope)

  const text = buildPruneText(scope, snapshotted, skipped, warnings, pruned)
  return {
    text,
    structured: { scope, snapshotted, skipped, warnings, guardEventId, pruned },
  }
}

// ---------------------------------------------------------------------------
// safe_compose_down — resolve project volumes, snapshot, then compose down
// ---------------------------------------------------------------------------
export interface SafeComposeDownResult {
  project: string
  removeVolumes: boolean
  resolvedVolumes: string[]
  snapshotted: string[]
  warnings: string[]
  guardEventId: string | null
  composeStdout?: string
}

export async function safeComposeDown(
  deps: ToolDeps,
  args: { project: string; removeVolumes: boolean },
): Promise<ToolResult<SafeComposeDownResult>> {
  const project = (args.project || '').trim()
  if (!project) throw new Error('safe_compose_down requires a project name.')
  const removeVolumes = !!args.removeVolumes
  const warnings: string[] = []
  let snapshotted: string[] = []
  let guardEventId: string | null = null

  // STEP 1 — resolve the project's named volumes via compose labels.
  const resolvedVolumes = await deps.docker.volumesForComposeProject(project)

  // STEP 2 — snapshot them FIRST, but only when -v will actually destroy them.
  if (removeVolumes && resolvedVolumes.length > 0) {
    try {
      const event = await deps.drk.snapshotNow(resolvedVolumes, 'compose_down_v')
      guardEventId = event.id
      snapshotted = event.volumes.filter(v => v.status === 'saved').map(v => v.volume)
      for (const s of event.volumes.filter(v => v.status !== 'saved')) {
        warnings.push(`Volume "${s.volume}" was not snapshotted (${s.status}${s.detail ? `: ${s.detail}` : ''}).`)
      }
    } catch (err: any) {
      warnings.push(
        `WARNING: guard snapshot FAILED before "compose down -v" (${err?.message || err}). ` +
          'Proceeding fail-open — volumes destroyed may NOT be recoverable.',
      )
    }
  } else if (removeVolumes) {
    warnings.push(`No named volumes found for compose project "${project}"; nothing to snapshot.`)
  }

  // STEP 3 — bring the stack down (compose CLI; degrades with a clear error).
  const { stdout, stderr } = await deps.docker.composeDown(project, removeVolumes)

  const text =
    `compose down${removeVolumes ? ' -v' : ''} for project "${project}" complete. ` +
    (removeVolumes
      ? `Snapshotted ${snapshotted.length}/${resolvedVolumes.length} named volume(s) first.`
      : 'Volumes left intact (no -v).') +
    (warnings.length ? `\nWarnings:\n${warnings.map(w => `- ${w}`).join('\n')}` : '')
  return {
    text,
    structured: {
      project,
      removeVolumes,
      resolvedVolumes,
      snapshotted,
      warnings,
      guardEventId,
      composeStdout: (stdout || stderr || '').trim() || undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// undo_last
// ---------------------------------------------------------------------------
export interface UndoLastResult {
  eventId: string | null
  restored: string[]
  message: string
}

export async function undoLast(deps: ToolDeps): Promise<ToolResult<UndoLastResult>> {
  const events = await deps.drk.listEvents({ limit: 1, status: 'saved' })
  const latest = events[0]
  if (!latest) {
    const message = 'No restorable ("saved") guard snapshot found to undo.'
    return { text: message, structured: { eventId: null, restored: [], message } }
  }
  const { restored } = await deps.drk.restore(latest.id)
  const message =
    `Restored ${restored.length} volume(s) from guard event ${latest.id}: ${restored.join(', ') || '(none)'}. ` +
    'Re-create the affected containers to use the restored data.'
  return { text: message, structured: { eventId: latest.id, restored, message } }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function normalizeVolumes(volumes: string[] | undefined): string[] {
  if (!Array.isArray(volumes)) return []
  return Array.from(new Set(volumes.map(v => String(v).trim()).filter(Boolean)))
}

function buildPruneText(
  scope: PruneScope,
  snapshotted: string[],
  skipped: string[],
  warnings: string[],
  pruned: { spaceReclaimed: number; deleted: string[] },
): string {
  const lines = [
    `safe_prune(${scope}) complete. Reclaimed ${fmtBytes(pruned.spaceReclaimed)}, removed ${pruned.deleted.length} item(s).`,
  ]
  if (snapshotted.length) lines.push(`Snapshotted first: ${snapshotted.join(', ')}.`)
  if (skipped.length) lines.push(`Not snapshotted: ${skipped.join(', ')}.`)
  if (warnings.length) lines.push('Warnings:', ...warnings.map(w => `- ${w}`))
  return lines.join('\n')
}

function fmtBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
