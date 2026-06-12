/**
 * Server configuration resolved from the environment.
 *
 * The MCP server is a thin client: it talks to the DRK backend over the local
 * REST API for *snapshots* (the guard owns the snapshot engine) and to the
 * Docker daemon directly for the *destructive* op (prune / compose down).
 *
 * Env:
 *   DRK_URL      — DRK backend base URL          (default http://localhost:42880)
 *   DRK_API_KEY  — x-api-key for the DRK backend (required for guard calls)
 *   DOCKER_HOST  — optional; passed to dockerode. When unset, dockerode falls
 *                  back to the platform default socket (/var/run/docker.sock on
 *                  Linux/Docker Desktop VM, //./pipe/docker_engine on Windows).
 */
export interface McpConfig {
  drkUrl: string
  drkApiKey: string
  dockerHost?: string
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return {
    drkUrl: env.DRK_URL || 'http://localhost:42880',
    drkApiKey: env.DRK_API_KEY || env.API_KEY || '',
    dockerHost: env.DOCKER_HOST || undefined,
  }
}
