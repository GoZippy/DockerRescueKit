import { parseDockerHost, summarizePrune, DockerOps } from '../docker'

describe('parseDockerHost', () => {
  it('parses unix sockets', () => {
    expect(parseDockerHost('unix:///var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' })
  })
  it('parses windows named pipes', () => {
    expect(parseDockerHost('npipe:////./pipe/docker_engine')).toEqual({ socketPath: '//./pipe/docker_engine' })
  })
  it('parses tcp host:port', () => {
    expect(parseDockerHost('tcp://10.0.0.5:2375')).toEqual({ host: '10.0.0.5', port: 2375 })
  })
  it('treats a bare path as a socket', () => {
    expect(parseDockerHost('/run/docker.sock')).toEqual({ socketPath: '/run/docker.sock' })
  })
})

describe('summarizePrune', () => {
  it('flattens a volume prune result', () => {
    const r = summarizePrune('volumes', { VolumesDeleted: ['a', 'b'], SpaceReclaimed: 100 })
    expect(r.spaceReclaimed).toBe(100)
    expect(r.deleted).toEqual(['a', 'b'])
    expect(r.scope).toBe('volumes')
  })
  it('aggregates a system prune across containers/images/networks', () => {
    const r = summarizePrune('system', {
      containers: { ContainersDeleted: ['c1'], SpaceReclaimed: 10 },
      images: { ImagesDeleted: [{ Deleted: 'img1' }], SpaceReclaimed: 20 },
      networks: { NetworksDeleted: ['n1'] },
    })
    expect(r.spaceReclaimed).toBe(30)
    expect(r.deleted).toEqual(expect.arrayContaining(['c1', 'img1', 'n1']))
  })
})

describe('DockerOps.composeDown — project validation', () => {
  // Inject a stub dockerode so the constructor doesn't open a real socket.
  const ops = new DockerOps({} as any, {} as any)

  it('rejects a flag-shaped project name before spawning (argument injection)', async () => {
    await expect(ops.composeDown('--help', true)).rejects.toThrow(/invalid compose project name/)
    await expect(ops.composeDown('-f/etc/passwd', false)).rejects.toThrow(/invalid compose project name/)
    await expect(ops.composeDown('', true)).rejects.toThrow(/invalid compose project name/)
  })
})
