import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z, type ZodRawShape } from 'zod'
import { DrkGuardClient } from './drkClient'
import { DockerOps } from './docker'
import type { McpConfig } from './config'
import {
  listGuardSnapshots,
  snapshotVolumes,
  safePrune,
  safeComposeDown,
  undoLast,
  type ToolDeps,
  type ToolResult,
} from './tools'

/**
 * Build the drk-mcp MCP server and register every Prune Guard tool.
 *
 * Tool descriptions are written FOR AI AGENTS: each states the precondition,
 * the guarantee, and WHEN to prefer the safe tool over a raw `docker` call.
 * This is the product's pitch to the agent — "snapshot first, then prune".
 */
export function buildServer(cfg: McpConfig, deps?: Partial<ToolDeps>): McpServer {
  const toolDeps: ToolDeps = {
    drk: deps?.drk ?? new DrkGuardClient(cfg),
    docker: deps?.docker ?? new DockerOps(cfg),
  }

  const server = new McpServer(
    { name: 'drk-mcp', version: '1.4.1' },
    {
      instructions:
        'Docker Rescue Kit guard tools. ALWAYS prefer safe_prune over raw `docker system/volume/image prune`, ' +
        'and safe_compose_down over raw `docker compose down -v`: these snapshot the affected named volumes FIRST ' +
        'so a mistaken cleanup is recoverable with undo_last. Prompts and denylists get bypassed; backups do not.',
    },
  )

  // Wrap a ToolResult into the MCP content envelope (text + structured JSON).
  const reply = <T>(r: ToolResult<T>): CallToolResult => ({
    content: [{ type: 'text', text: r.text }],
    structuredContent: r.structured as Record<string, unknown>,
  })

  // Typed thin wrapper over registerTool. Fixing the generic to a concrete
  // ZodRawShape + a CallToolResult handler keeps call sites type-checked while
  // avoiding the SDK generic's excessively-deep instantiation (TS2589).
  type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>
  const register = (
    name: string,
    config: { title: string; description: string; inputSchema: ZodRawShape },
    handler: Handler,
  ): void => {
    ;(server.registerTool as unknown as (n: string, c: typeof config, h: Handler) => void)(name, config, handler)
  }

  register(
    'list_guard_snapshots',
    {
      title: 'List recent guard snapshots',
      description:
        'List the 20 most recent Prune Guard snapshot events (what DRK saved before recent destructive ops). ' +
        'Use this to find an event id to restore, or to confirm a volume was protected before you prune. ' +
        'Read-only; safe to call anytime.',
      inputSchema: {},
    },
    async () => reply(await listGuardSnapshots(toolDeps)),
  )

  register(
    'snapshot_volumes',
    {
      title: 'Snapshot named volumes now',
      description:
        'Ask DRK to take a guard snapshot of the given named Docker volumes RIGHT NOW (a local, evictable safety ' +
        'copy), awaiting completion. Call this BEFORE any risky operation you are about to run yourself against ' +
        'those volumes. Returns which volumes were saved, skipped (too large), or failed. Named volumes only — ' +
        'bind mounts and anonymous volumes are not covered.',
      inputSchema: {
        volumes: z.array(z.string().min(1)).min(1).describe('Named Docker volumes to snapshot before a risky op.'),
      },
    },
    async args => reply(await snapshotVolumes(toolDeps, { volumes: args.volumes as string[] })),
  )

  register(
    'safe_prune',
    {
      title: 'Snapshot-then-prune (preferred over raw docker prune)',
      description:
        'PREFER THIS over `docker system prune`, `docker volume prune`, or `docker image prune`. It snapshots the ' +
        'in-scope named volumes via DRK FIRST, awaits completion, THEN performs the prune against the Docker ' +
        'daemon. For scope="volumes" or "system" pass the volume names you expect to be affected so they can be ' +
        'guarded; "images"/"containers" do not destroy volume data. Returns { snapshotted, skipped, warnings, ' +
        'pruned }. FAIL-OPEN: if the snapshot fails the prune still proceeds but a prominent WARNING is returned — ' +
        'inspect warnings and decide whether to continue. Use undo_last to recover.',
      inputSchema: {
        scope: z
          .enum(['system', 'volumes', 'images', 'containers'])
          .describe('What to prune. Only "system" and "volumes" can destroy volume data.'),
        volumes: z
          .array(z.string().min(1))
          .optional()
          .describe('Named volumes expected to be affected, to snapshot before the prune (scope system/volumes).'),
      },
    },
    async args =>
      reply(
        await safePrune(toolDeps, {
          scope: args.scope as 'system' | 'volumes' | 'images' | 'containers',
          volumes: args.volumes as string[] | undefined,
        }),
      ),
  )

  register(
    'safe_compose_down',
    {
      title: 'Snapshot-then-compose-down (preferred over raw compose down -v)',
      description:
        'PREFER THIS over `docker compose down -v`. Resolves the compose project\'s named volumes (via the ' +
        'com.docker.compose.project label), snapshots them via DRK FIRST when removeVolumes=true, THEN runs ' +
        '`docker compose down [-v]` via the compose CLI (which must be installed and on PATH). With ' +
        'removeVolumes=false no data is destroyed and no snapshot is taken. Returns the resolved + snapshotted ' +
        'volumes and any warnings. Degrades with a clear error if the compose CLI is missing.',
      inputSchema: {
        project: z.string().min(1).describe('The compose project name (com.docker.compose.project).'),
        removeVolumes: z
          .boolean()
          .describe('Pass -v to also remove the project\'s named volumes (destructive — triggers a snapshot first).'),
      },
    },
    async args =>
      reply(
        await safeComposeDown(toolDeps, {
          project: args.project as string,
          removeVolumes: args.removeVolumes as boolean,
        }),
      ),
  )

  register(
    'undo_last',
    {
      title: 'Undo the last destructive op',
      description:
        'Restore the data from the most recent "saved" guard snapshot — the one-click undo after a mistaken prune ' +
        'or compose down -v. Restores volume DATA only; you must re-create the affected containers afterward to ' +
        'use it. Call this immediately when the user says an agent (or they) just deleted data.',
      inputSchema: {},
    },
    async () => reply(await undoLast(toolDeps)),
  )

  return server
}
