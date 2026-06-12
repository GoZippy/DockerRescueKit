import axios, { AxiosInstance } from 'axios'
import type { GuardEvent } from '@docker-rescue-kit/shared'
import type { McpConfig } from './config'

/**
 * Thin wrapper over the DRK Prune Guard REST surface (PRUNE_GUARD.md §9).
 *
 * Every method maps 1:1 to a guard endpoint so the tool layer reads as
 * intent, and so the test suite can assert the exact call shape + ORDER.
 *
 * CONTRACT NOTE (PG-1.4): §9 has no "snapshot now" endpoint. `snapshotNow`
 * targets `POST /api/guard/snapshot`, a REQUIRED-CONTRACT-ADDITION the PG-1.4
 * route module must add (it wraps the existing
 * `PruneGuardService.guard(kind, 'mcp', volumes)` core, which already exists).
 * See README "Required contract addition".
 */
export class DrkGuardClient {
  private readonly http: AxiosInstance

  constructor(cfg: McpConfig, http?: AxiosInstance) {
    this.http =
      http ??
      axios.create({
        baseURL: cfg.drkUrl.replace(/\/+$/, '') + '/api',
        headers: {
          'x-api-key': cfg.drkApiKey,
          'Content-Type': 'application/json',
        },
        timeout: 120_000,
      })
  }

  /** GET /api/guard/events?limit=&status=&before= (§9). */
  async listEvents(opts: { limit?: number; status?: string; before?: string } = {}): Promise<GuardEvent[]> {
    const res = await this.http.get('/guard/events', { params: opts })
    return res.data as GuardEvent[]
  }

  /** GET /api/guard/events/:id — full event (§9). */
  async getEvent(id: string): Promise<GuardEvent> {
    const res = await this.http.get(`/guard/events/${encodeURIComponent(id)}`)
    return res.data as GuardEvent
  }

  /**
   * POST /api/guard/snapshot — snapshot the named volumes NOW, awaiting
   * completion, and return the persisted GuardEvent.
   *
   * REQUIRED-CONTRACT-ADDITION (not in §9): the only "snapshot now" path in §9
   * today is the dev-only `POST /api/guard/test` (gated behind DRK_GUARD_TEST=1),
   * which is unsuitable for production agent traffic. PG-1.4 must expose this
   * endpoint as a thin wrapper over `PruneGuardService.guard('<kind>','mcp',vols)`.
   */
  async snapshotNow(volumes: string[], kind = 'system_prune'): Promise<GuardEvent> {
    const res = await this.http.post('/guard/snapshot', { kind, trigger: 'mcp', volumes })
    return res.data as GuardEvent
  }

  /** POST /api/guard/events/:id/restore (§9). */
  async restore(id: string, volumes?: string[]): Promise<{ restored: string[] }> {
    const res = await this.http.post(`/guard/events/${encodeURIComponent(id)}/restore`, volumes ? { volumes } : {})
    return res.data as { restored: string[] }
  }
}
