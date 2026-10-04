import Docker from 'dockerode'
import fs from 'fs-extra'
import path from 'path'
import zlib from 'zlib'

export interface ComposeStack {
  project: string
  containers: Docker.ContainerInfo[]
  volumes: string[]
  networks: string[]
}

/**
 * Docker's own configuration state, as opposed to the payload it hosts.
 * Captured alongside every backup so a corrupted network store can be repaired
 * by replay instead of a factory reset.
 */
export interface ControlPlaneSnapshot {
  capturedAt: string
  daemon: {
    version?: string
    apiVersion?: string
    os?: string
    kernel?: string
  }
  /** Full inspect output for every network visible to the daemon. */
  networks: any[]
}

export class DockerService {
  private docker: Docker

  constructor() {
    this.docker = new Docker({
      socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'
    })
  }

  public async ping(): Promise<boolean> {
    try {
      await this.docker.ping()
      return true
    } catch {
      return false
    }
  }

  public async version() {
    return await this.docker.version()
  }

  public async listContainers() {
    return await this.docker.listContainers({ all: true })
  }

  public async listVolumes() {
    const response = await this.docker.listVolumes()
    return response.Volumes || []
  }

  public async listImages() {
    return await this.docker.listImages()
  }

  public async listNetworks() {
    return await this.docker.listNetworks()
  }

  /**
   * Group all containers/volumes/networks by docker-compose project name.
   * Homelabbers manage stacks, not individual containers — backup policies
   * should follow the same mental model.
   */
  public async listComposeStacks(): Promise<ComposeStack[]> {
    const containers = await this.listContainers()
    const volumes = await this.listVolumes()
    const networks = await this.listNetworks()

    const byProject = new Map<string, ComposeStack>()
    for (const c of containers) {
      const project = c.Labels?.['com.docker.compose.project']
      if (!project) continue
      if (!byProject.has(project)) {
        byProject.set(project, { project, containers: [], volumes: [], networks: [] })
      }
      byProject.get(project)!.containers.push(c)
    }
    for (const v of volumes) {
      const project = v.Labels?.['com.docker.compose.project']
      if (project && byProject.has(project)) byProject.get(project)!.volumes.push(v.Name)
    }
    for (const n of networks) {
      const project = n.Labels?.['com.docker.compose.project']
      if (project && byProject.has(project)) byProject.get(project)!.networks.push(n.Name)
    }
    return Array.from(byProject.values())
  }

  /**
   * Export a Docker volume's contents as a gzipped tarball by running a
   * throwaway alpine container that tars /data and pipes stdout.
   *
   * Why: the Docker API doesn't expose volume contents directly; the helper
   * container pattern is the standard way. Previous implementation created
   * an unused archiver AND piped container logs to the same file, producing
   * corrupt output.
   */
  public async exportVolume(volumeName: string, destPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(destPath))

    await this.ensureImage('alpine:3.19')

    const container = await this.docker.createContainer({
      Image: 'alpine:3.19',
      Cmd: ['tar', 'czf', '-', '-C', '/data', '.'],
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${volumeName}:/data:ro`],
        AutoRemove: false
      }
    })

    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      const output = fs.createWriteStream(destPath)

      // Dockerode multiplexes stdout+stderr on a single stream — demux so stderr
      // doesn't corrupt our tar.
      const stderrChunks: Buffer[] = []
      const stderrCollector = new (require('stream').Writable)({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          stderrChunks.push(chunk)
          cb()
        }
      })
      this.docker.modem.demuxStream(stream, output, stderrCollector)

      await container.start()
      const waitResult = await container.wait()

      await new Promise<void>((resolve, reject) => {
        output.on('finish', () => resolve())
        output.on('error', reject)
        output.end()
      })

      if (waitResult.StatusCode !== 0) {
        const err = Buffer.concat(stderrChunks).toString('utf-8')
        throw new Error(`tar exited ${waitResult.StatusCode}: ${err}`)
      }
    } finally {
      try { await container.remove({ force: true }) } catch { /* already gone */ }
    }
  }

  /**
   * Restore a volume by creating it (if missing) and extracting a tarball
   * inside a helper container. `srcPath` must already be resolved by the
   * caller to a path inside the app's backup staging dir.
   */
  public async importVolume(volumeName: string, srcPath: string): Promise<void> {
    const resolved = path.resolve(srcPath)
    if (!(await fs.pathExists(resolved))) {
      throw new Error(`Backup file not found: ${resolved}`)
    }

    await this.ensureVolume(volumeName)
    await this.ensureImage('alpine:3.19')

    const container = await this.docker.createContainer({
      Image: 'alpine:3.19',
      Cmd: ['sh', '-c', 'cd /data && tar xzf -'],
      Tty: false,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${volumeName}:/data`],
        AutoRemove: false
      }
    })

    try {
      const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true })

      await container.start()

      await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(resolved)
        input.on('error', reject)
        stream.on('error', reject)
        stream.on('finish', resolve)
        input.pipe(stream)
      })

      const waitResult = await container.wait()
      if (waitResult.StatusCode !== 0) {
        throw new Error(`tar extract exited with ${waitResult.StatusCode}`)
      }
    } finally {
      try { await container.remove({ force: true }) } catch { /* already gone */ }
    }
  }

  public async exportContainer(containerId: string, destPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(destPath))
    const container = this.docker.getContainer(containerId)
    const stream = await container.export()
    const output = fs.createWriteStream(destPath)
    const compress = destPath.endsWith('.gz')
    const finalStream: any = compress ? stream.pipe(zlib.createGzip()) : stream

    await new Promise<void>((resolve, reject) => {
      finalStream.pipe(output)
      output.on('finish', () => resolve())
      output.on('error', reject)
      finalStream.on('error', reject)
      stream.on('error', reject)
    })
  }

  public async importImage(tarPath: string): Promise<void> {
    const resolved = path.resolve(tarPath)
    const input = fs.createReadStream(resolved)
    const stream = await this.docker.loadImage(input)
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve())
    })
  }

  /**
   * Save a Docker image to a tarball on disk. The "image" backup target type
   * lets users snapshot the actual image layers (not just the container
   * filesystem), which is what you want before upgrading mission-critical
   * images.
   */
  public async exportImage(imageName: string, destPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(destPath))
    const img = this.docker.getImage(imageName)
    const stream = await img.get()
    const output = fs.createWriteStream(destPath)
    const compress = destPath.endsWith('.gz')
    const finalStream: any = compress ? stream.pipe(zlib.createGzip()) : stream

    await new Promise<void>((resolve, reject) => {
      finalStream.pipe(output)
      output.on('finish', () => resolve())
      output.on('error', reject)
      finalStream.on('error', reject)
      stream.on('error', reject)
    })
  }

  /**
   * Export a Docker network's configuration as JSON. Networks don't have
   * content, only settings, so the backup is just the inspect output and the
   * restore is a plain `networks.create`.
   */
  public async exportNetwork(networkName: string, destPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(destPath))
    const info = await this.docker.getNetwork(networkName).inspect()
    await fs.writeJson(path.resolve(destPath), info, { spaces: 2 })
  }

  public async importNetwork(srcPath: string): Promise<string> {
    const resolved = path.resolve(srcPath)
    const info = await fs.readJson(resolved)
    try {
      await this.docker.getNetwork(info.Name).inspect()
      return info.Name
    } catch { /* doesn't exist, create it */ }

    const created = await this.docker.createNetwork({
      Name: info.Name,
      Driver: info.Driver,
      IPAM: info.IPAM,
      Internal: info.Internal,
      Attachable: info.Attachable,
      EnableIPv6: info.EnableIPv6,
      Labels: info.Labels,
      Options: info.Options
    })
    return (created as any).id || info.Name
  }

  /**
   * Execute a command inside a running container and capture stdout/stderr.
   */
  public async execInContainer(
    containerId: string,
    cmd: string[],
    opts: { timeoutMs?: number } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const container = this.docker.getContainer(containerId)
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true
    })

    const stream = await exec.start({ hijack: true, stdin: false })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const stdoutWriter = new (require('stream').Writable)({
      write(c: Buffer, _e: string, cb: () => void) { stdoutChunks.push(c); cb() }
    })
    const stderrWriter = new (require('stream').Writable)({
      write(c: Buffer, _e: string, cb: () => void) { stderrChunks.push(c); cb() }
    })
    this.docker.modem.demuxStream(stream, stdoutWriter, stderrWriter)

    const timeoutMs = opts.timeoutMs ?? 5 * 60_000
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`exec timeout after ${timeoutMs}ms`)), timeoutMs)
      stream.on('end', () => { clearTimeout(timer); resolve() })
      stream.on('error', err => { clearTimeout(timer); reject(err) })
    })

    const info = await exec.inspect()
    return {
      exitCode: info.ExitCode ?? -1,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8')
    }
  }

  /**
   * Cheap content fingerprint of a volume for Prune Guard dedup (PG-1.2, §6.5):
   * a sha256 over a `size mtime path` manifest, NOT a full content hash, so it's
   * fast on the hot path. Mirrors exportVolume's `:ro` alpine helper pattern.
   *
   * The spec's `find -printf` is GNU-only; alpine's busybox `find` lacks it, so
   * we use busybox-compatible `stat -c` (size + mtime + name), sorted for a
   * stable order, then sha256sum. Optionally labels the helper container with
   * `com.gozippy.drk.guard=<label>` so the boot reaper can clean crash debris.
   */
  public async fingerprintVolume(volumeName: string, label?: string): Promise<string> {
    await this.ensureImage('alpine:3.19')

    const container = await this.docker.createContainer({
      Image: 'alpine:3.19',
      Cmd: ['sh', '-c', "find /data -exec stat -c '%s %Y %n' {} ';' | sort | sha256sum | cut -d' ' -f1"],
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${volumeName}:/data:ro`],
        AutoRemove: false
      },
      ...(label ? { Labels: { 'com.gozippy.drk.guard': label } } : {})
    } as any)

    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      const stdoutCollector = new (require('stream').Writable)({
        write(c: Buffer, _e: string, cb: () => void) { stdoutChunks.push(c); cb() }
      })
      const stderrCollector = new (require('stream').Writable)({
        write(c: Buffer, _e: string, cb: () => void) { stderrChunks.push(c); cb() }
      })
      this.docker.modem.demuxStream(stream, stdoutCollector, stderrCollector)

      await container.start()
      const waitResult = await container.wait()
      if (waitResult.StatusCode !== 0) {
        const err = Buffer.concat(stderrChunks).toString('utf-8')
        throw new Error(`fingerprint exited ${waitResult.StatusCode}: ${err}`)
      }
      return Buffer.concat(stdoutChunks).toString('utf-8').trim()
    } finally {
      try { await container.remove({ force: true }) } catch { /* already gone */ }
    }
  }

  /**
   * Apparent on-disk size of a volume in bytes, via a `:ro` alpine helper
   * running busybox `du -s -b`. Used by Prune Guard (PG-1.2) to enforce the
   * per-volume cap BEFORE taring, so a known-huge volume is skipped cheaply
   * rather than tarred-then-discarded. Best-effort: returns 0 on any failure
   * (caller falls back to the post-tar size check).
   */
  public async volumeSizeBytes(volumeName: string): Promise<number> {
    try {
      await this.ensureImage('alpine:3.19')
      const container = await this.docker.createContainer({
        Image: 'alpine:3.19',
        Cmd: ['sh', '-c', 'du -s -b /data 2>/dev/null | cut -f1'],
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: { Binds: [`${volumeName}:/data:ro`], AutoRemove: false }
      })
      try {
        const stream = await container.attach({ stream: true, stdout: true, stderr: true })
        const out: Buffer[] = []
        const collector = new (require('stream').Writable)({
          write(c: Buffer, _e: string, cb: () => void) { out.push(c); cb() }
        })
        const sink = new (require('stream').Writable)({ write(_c: Buffer, _e: string, cb: () => void) { cb() } })
        this.docker.modem.demuxStream(stream, collector, sink)
        await container.start()
        await container.wait()
        const n = parseInt(Buffer.concat(out).toString('utf-8').trim(), 10)
        return Number.isFinite(n) ? n : 0
      } finally {
        try { await container.remove({ force: true }) } catch { /* already gone */ }
      }
    } catch {
      return 0
    }
  }

  /**
   * Capture Docker's control-plane state — the daemon's own configuration
   * rather than the payload it hosts.
   *
   * WHY: a corrupted network store can make the daemon unstartable, and the
   * only in-product remedy Docker offers is a factory reset. Repairing it means
   * clearing the store, which erases every user-defined network. Holding a
   * recent copy of the network definitions turns that from data loss into a
   * replay.
   *
   * This deliberately captures ALL networks, not just the ones a policy targets
   * — the point is to be able to rebuild the network topology wholesale.
   *
   * Note the boundary: DRK's backend runs inside a container and cannot read
   * /var/lib/docker directly, so this captures the logical definitions over the
   * API rather than the raw boltdb file. That is the better artefact anyway —
   * portable across hosts and Docker versions, where the raw store is not.
   */
  public async captureControlPlane(): Promise<ControlPlaneSnapshot> {
    const snapshot: ControlPlaneSnapshot = {
      capturedAt: new Date().toISOString(),
      daemon: {},
      networks: []
    }

    try {
      const version = await this.docker.version()
      snapshot.daemon = {
        version: version?.Version,
        apiVersion: version?.ApiVersion,
        os: version?.Os,
        kernel: version?.KernelVersion
      }
    } catch { /* daemon detail is best-effort */ }

    try {
      const networks = await this.docker.listNetworks()
      for (const summary of networks) {
        try {
          snapshot.networks.push(await this.docker.getNetwork(summary.Id).inspect())
        } catch {
          // A network can disappear between list and inspect. Keep the summary
          // rather than dropping it entirely.
          snapshot.networks.push(summary)
        }
      }
    } catch { /* leave networks empty */ }

    return snapshot
  }

  /**
   * Recreate user-defined networks from a control-plane snapshot.
   *
   * Skips Docker's predefined networks, anything that already exists, and — the
   * important one — any entry whose bridge name is already claimed. Replaying a
   * snapshot naively is how you reintroduce a duplicate-bridge conflict, which
   * is the exact failure this feature exists to recover from.
   */
  public async restoreNetworksFromSnapshot(
    snapshot: ControlPlaneSnapshot
  ): Promise<{ created: string[]; skipped: Array<{ name: string; reason: string }> }> {
    const created: string[] = []
    const skipped: Array<{ name: string; reason: string }> = []

    // bridge/host/none are created by the daemon; ingress and docker_gwbridge
    // are swarm-managed. Attempting any of them yields a confusing raw dockerode
    // error instead of a clear "not ours to recreate".
    const predefined = new Set(['bridge', 'host', 'none', 'ingress', 'docker_gwbridge'])
    const bridgeNameOf = (net: any): string | undefined =>
      net?.Options?.['com.docker.network.bridge.name']

    const existing = await this.docker.listNetworks()
    const existingNames = new Set(existing.map((n: any) => n.Name))
    const claimedBridges = new Set<string>()
    for (const net of existing) {
      const bridge = bridgeNameOf(net)
      if (bridge) claimedBridges.add(bridge)
    }
    // The default bridge always owns docker0 whether or not it is labelled.
    claimedBridges.add('docker0')

    for (const net of snapshot.networks) {
      const name: string = net?.Name
      if (!name) continue

      if (predefined.has(name)) {
        skipped.push({ name, reason: 'daemon- or swarm-managed network, not ours to recreate' })
        continue
      }
      if (existingNames.has(name)) {
        skipped.push({ name, reason: 'already exists' })
        continue
      }

      const bridge = bridgeNameOf(net)
      if (bridge && claimedBridges.has(bridge)) {
        skipped.push({
          name,
          reason: `bridge name "${bridge}" already claimed — recreating would block daemon startup`
        })
        continue
      }

      try {
        await this.docker.createNetwork({
          Name: name,
          Driver: net.Driver,
          EnableIPv6: net.EnableIPv6,
          IPAM: net.IPAM,
          Internal: net.Internal,
          Attachable: net.Attachable,
          Ingress: net.Ingress,
          Options: net.Options,
          Labels: net.Labels
        })
        created.push(name)
        existingNames.add(name)
        if (bridge) claimedBridges.add(bridge)
      } catch (err: any) {
        skipped.push({ name, reason: err?.message || 'create failed' })
      }
    }

    return { created, skipped }
  }

  /**
   * Remove a volume by name.
   *
   * `force` is appropriate when tearing down a scratch volume this process
   * created and still owns. Prefer `force: false` when reaping volumes left
   * behind by a previous process — a non-forced remove fails loudly if the
   * volume is unexpectedly in use, instead of ripping it out from under a
   * running container.
   */
  public async removeVolume(name: string, force = true): Promise<void> {
    await this.docker.getVolume(name).remove({ force })
  }

  private async ensureVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).inspect()
    } catch {
      await this.docker.createVolume({ Name: name })
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect()
      return
    } catch {
      // not present — pull
    }
    const stream = await this.docker.pull(image)
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve())
    })
  }
}
