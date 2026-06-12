import type { AxiosInstance } from 'axios'
import { DrkGuardClient } from '../drkClient'

function fakeHttp() {
  const get = jest.fn(async (): Promise<{ data: unknown }> => ({ data: [] }))
  const post = jest.fn(async (): Promise<{ data: unknown }> => ({ data: { restored: [] } }))
  return { get, post, instance: { get, post } as unknown as AxiosInstance }
}

const cfg = { drkUrl: 'http://localhost:42880', drkApiKey: 'k' }

describe('DrkGuardClient — §9 REST contract mapping', () => {
  it('list_guard_snapshots → GET /guard/events?limit=20', async () => {
    const h = fakeHttp()
    const c = new DrkGuardClient(cfg, h.instance)
    await c.listEvents({ limit: 20 })
    expect(h.get).toHaveBeenCalledWith('/guard/events', { params: { limit: 20 } })
  })

  it('undo_last list → GET /guard/events?limit=1&status=saved', async () => {
    const h = fakeHttp()
    const c = new DrkGuardClient(cfg, h.instance)
    await c.listEvents({ limit: 1, status: 'saved' })
    expect(h.get).toHaveBeenCalledWith('/guard/events', { params: { limit: 1, status: 'saved' } })
  })

  it('snapshotNow → POST /guard/snapshot (REQUIRED-CONTRACT-ADDITION) with trigger mcp', async () => {
    const h = fakeHttp()
    h.post.mockResolvedValueOnce({ data: { id: 'e', volumes: [] } })
    const c = new DrkGuardClient(cfg, h.instance)
    await c.snapshotNow(['v1', 'v2'], 'volume_prune')
    expect(h.post).toHaveBeenCalledWith('/guard/snapshot', {
      kind: 'volume_prune',
      trigger: 'mcp',
      volumes: ['v1', 'v2'],
    })
  })

  it('restore → POST /guard/events/:id/restore (url-encoded id)', async () => {
    const h = fakeHttp()
    h.post.mockResolvedValueOnce({ data: { restored: ['v1'] } })
    const c = new DrkGuardClient(cfg, h.instance)
    const r = await c.restore('evt 1', ['v1'])
    expect(h.post).toHaveBeenCalledWith('/guard/events/evt%201/restore', { volumes: ['v1'] })
    expect(r.restored).toEqual(['v1'])
  })

  it('restore without volumes posts an empty body (restore all)', async () => {
    const h = fakeHttp()
    h.post.mockResolvedValueOnce({ data: { restored: [] } })
    const c = new DrkGuardClient(cfg, h.instance)
    await c.restore('evt-1')
    expect(h.post).toHaveBeenCalledWith('/guard/events/evt-1/restore', {})
  })
})
