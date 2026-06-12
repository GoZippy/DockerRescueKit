import Docker from 'dockerode'
import { spawn } from 'child_process'
import type { McpConfig } from './config'

export type PruneScope = 'system' | 'volumes' | 'images' | 'containers'

export interface PruneResult {
  scope: PruneScope
  spaceReclaimed: number
  deleted: string[]
  raw: unknown
}

/**
 * Direct Docker daemon access for the *destructive* half of snapshot-then-act.
 *
 * Snapshots are owned by the DRK backend (it holds the guard cache); the MCP
 * server only performs the prune/compose-down AFTER the snapshot has completed,
 * so it talks to the daemon directly via dockerode (and the compose CLI via
 * child_process — compose has no dockerode API).
 *
 * Connection: honors DOCKER_HOST when set, else the platform default socket
 * (/var/run/docker.sock on Linux/Docker Desktop, //./pipe/docker_engine on Win).
 */
export class DockerOps {
  private readonly docker: Docker

  constructor(cfg: McpConfig, docker?: Docker) {
    if (docker) {
      this.docker = docker
    } else if (cfg.dockerHost) {
      // dockerode parses DOCKER_HOST via its own options when given host/port;
      // for tcp:// or unix:// strings we hand it the parsed pieces.
      this.docker = new Docker(parseDockerHost(cfg.dockerHost))
    } else {
      this.docker = new Docker({
        socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock',
      })
    }
  }

  /**
   * Resolve the named volumes attached to a compose project via the
   * `com.docker.compose.project` label (the same label compose itself sets).
   * Anonymous/bind volumes are excluded — DRK only guards named volumes.
   */
  async volumesForComposeProject(project: string): Promise<string[]> {
    const res = await this.docker.listVolumes({
      filters: { label: [`com.docker.compose.project=${project}`] },
    })
    const vols = (res?.Volumes ?? [])
      .map(v => v.Name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
    return Array.from(new Set(vols))
  }

  /** Run a daemon-side prune for the given scope. */
  async prune(scope: PruneScope): Promise<PruneResult> {
    let raw: any
    switch (scope) {
      case 'system':
        // dockerode has no single "system prune"; system prune = containers +
        // images + networks (+ volumes only with the volumes flag, which we do
        // NOT pass — volume removal is the guarded path the caller snapshots).
        raw = {
          containers: await this.docker.pruneContainers(),
          images: await this.docker.pruneImages(),
          networks: await this.docker.pruneNetworks(),
        }
        break
      case 'volumes':
        raw = await this.docker.pruneVolumes()
        break
      case 'images':
        raw = await this.docker.pruneImages()
        break
      case 'containers':
        raw = await this.docker.pruneContainers()
        break
    }
    return summarizePrune(scope, raw)
  }

  /** `docker compose down [-v]` via the compose CLI (no dockerode equivalent). */
  async composeDown(project: string, removeVolumes: boolean): Promise<{ stdout: string; stderr: string }> {
    const args = ['compose', '-p', project, 'down']
    if (removeVolumes) args.push('-v')
    return runDocker(args)
  }
}

/** Translate a DOCKER_HOST string into dockerode constructor options. */
export function parseDockerHost(host: string): Docker.DockerOptions {
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) }
  if (host.startsWith('npipe://')) return { socketPath: host.slice('npipe://'.length) }
  const m = /^(?:tcp:\/\/)?([^:/]+):(\d+)/.exec(host)
  if (m) return { host: m[1], port: Number(m[2]) }
  // Bare path → treat as a socket.
  return { socketPath: host }
}

/** Flatten dockerode prune results into a uniform shape. */
export function summarizePrune(scope: PruneScope, raw: any): PruneResult {
  let spaceReclaimed = 0
  const deleted: string[] = []
  const accumulate = (r: any) => {
    if (!r) return
    if (typeof r.SpaceReclaimed === 'number') spaceReclaimed += r.SpaceReclaimed
    for (const key of ['VolumesDeleted', 'ImagesDeleted', 'ContainersDeleted', 'NetworksDeleted']) {
      const arr = r[key]
      if (Array.isArray(arr)) {
        for (const d of arr) deleted.push(typeof d === 'string' ? d : d?.Deleted || d?.Untagged || JSON.stringify(d))
      }
    }
  }
  if (scope === 'system') {
    accumulate(raw.containers)
    accumulate(raw.images)
    accumulate(raw.networks)
  } else {
    accumulate(raw)
  }
  return { scope, spaceReclaimed, deleted, raw }
}

/** Spawn the compose CLI; reject with a clear error when it is absent. */
function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err: any) {
      return reject(new Error(`docker compose CLI not available: ${err?.message || err}`))
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => (stdout += d.toString()))
    child.stderr?.on('data', d => (stderr += d.toString()))
    child.on('error', err =>
      reject(new Error(`docker compose CLI not available (is Docker on PATH?): ${err?.message || err}`)),
    )
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`docker compose down exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}
