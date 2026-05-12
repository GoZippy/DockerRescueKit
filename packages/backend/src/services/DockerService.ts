import Docker from 'dockerode'
import fs from 'fs-extra'
import path from 'path'

export interface ComposeStack {
  project: string
  containers: Docker.ContainerInfo[]
  volumes: string[]
  networks: string[]
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

    await new Promise<void>((resolve, reject) => {
      stream.pipe(output)
      output.on('finish', () => resolve())
      output.on('error', reject)
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
    await new Promise<void>((resolve, reject) => {
      stream.pipe(output)
      output.on('finish', () => resolve())
      output.on('error', reject)
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
