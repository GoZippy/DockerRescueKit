/**
 * Tests for DockerService — dockerode is fully mocked so no Docker daemon
 * needs to be running in CI.
 */

// ---- mock dockerode before any imports that might load it ------------------
const mockPing = jest.fn()
const mockListContainers = jest.fn()
const mockListVolumes = jest.fn()
const mockListNetworks = jest.fn()
const mockListImages = jest.fn()

jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => ({
    ping: mockPing,
    listContainers: mockListContainers,
    listVolumes: mockListVolumes,
    listNetworks: mockListNetworks,
    listImages: mockListImages,
  }))
})

import { DockerService } from '../services/DockerService'

// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
})

describe('DockerService.ping()', () => {
  it('returns true when daemon responds', async () => {
    mockPing.mockResolvedValue(undefined)
    const svc = new DockerService()
    expect(await svc.ping()).toBe(true)
  })

  it('returns false on ENOENT / any error', async () => {
    const err = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })
    mockPing.mockRejectedValue(err)
    const svc = new DockerService()
    expect(await svc.ping()).toBe(false)
  })
})

describe('DockerService.listContainers()', () => {
  it('returns the raw container list from dockerode', async () => {
    const fakeContainers = [
      { Id: 'abc123', Names: ['/my-app'], Status: 'running', Labels: {} },
      { Id: 'def456', Names: ['/my-db'], Status: 'exited', Labels: {} },
    ]
    mockListContainers.mockResolvedValue(fakeContainers)
    const svc = new DockerService()
    const result = await svc.listContainers()
    expect(result).toEqual(fakeContainers)
    expect(mockListContainers).toHaveBeenCalledWith({ all: true })
  })
})

describe('DockerService.listComposeStacks()', () => {
  it('groups containers by com.docker.compose.project label', async () => {
    mockListContainers.mockResolvedValue([
      { Id: 'c1', Names: ['/app-web'], Labels: { 'com.docker.compose.project': 'myapp' } },
      { Id: 'c2', Names: ['/app-db'],  Labels: { 'com.docker.compose.project': 'myapp' } },
      { Id: 'c3', Names: ['/solo'],    Labels: {} }, // no project label — excluded
    ])
    mockListVolumes.mockResolvedValue({ Volumes: [
      { Name: 'myapp_data', Labels: { 'com.docker.compose.project': 'myapp' } },
      { Name: 'orphan_vol', Labels: {} },
    ]})
    mockListNetworks.mockResolvedValue([
      { Name: 'myapp_net', Labels: { 'com.docker.compose.project': 'myapp' } },
    ])

    const svc = new DockerService()
    const stacks = await svc.listComposeStacks()

    expect(stacks).toHaveLength(1)
    const stack = stacks[0]
    expect(stack.project).toBe('myapp')
    expect(stack.containers).toHaveLength(2)
    expect(stack.volumes).toEqual(['myapp_data'])
    expect(stack.networks).toEqual(['myapp_net'])
  })

  it('returns empty array when no containers have a project label', async () => {
    mockListContainers.mockResolvedValue([
      { Id: 'x', Names: ['/standalone'], Labels: {} },
    ])
    mockListVolumes.mockResolvedValue({ Volumes: [] })
    mockListNetworks.mockResolvedValue([])

    const svc = new DockerService()
    expect(await svc.listComposeStacks()).toEqual([])
  })
})

describe('DockerService.listVolumes()', () => {
  it('returns the Volumes array from dockerode', async () => {
    const fakeVolumes = [
      { Name: 'vol1', Driver: 'local', Labels: {} },
      { Name: 'vol2', Driver: 'local', Labels: {} },
    ]
    mockListVolumes.mockResolvedValue({ Volumes: fakeVolumes })
    const svc = new DockerService()
    const result = await svc.listVolumes()
    expect(result).toEqual(fakeVolumes)
  })

  it('returns empty array when Volumes is absent', async () => {
    mockListVolumes.mockResolvedValue({})
    const svc = new DockerService()
    expect(await svc.listVolumes()).toEqual([])
  })
})
