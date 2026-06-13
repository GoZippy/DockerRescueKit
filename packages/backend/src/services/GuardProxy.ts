import fs from 'fs-extra'
import path from 'path'
import http from 'http'
import net from 'net'
import { URL } from 'url'
import type { PruneGuardService } from './PruneGuardService'
import type { DockerService } from './DockerService'
import type { SettingsService } from './SettingsService'
import type { AuditService } from './AuditService'
import { logger } from '../utils/logger'

/**
 * GuardProxy — PG-2.1, the Phase-2 socket proxy (docs/design/PRUNE_GUARD.md
 * §4b, §5 Phase 2, §7.1, §12 guarantee 6).
 *
 * The MVP floor + MCP catch the "user did nothing" and "agent cooperated"
 * cases. This is the defense-in-depth tier: agents/tools point at THIS socket
 * instead of /var/run/docker.sock, so EVERY destructive Engine-API call —
 * including a rogue agent's raw-socket call — gets snapshot-before-destroy.
 *
 * It is a dependency-free (node http/net only) reverse proxy that speaks the
 * Docker Engine API:
 *   - Non-destructive requests forward untouched (one hop, no parsing).
 *   - Destructive requests (volume rm/prune, container rm -v/prune) resolve
 *     their target volumes, call guard.guard() (snapshot-first), THEN forward.
 *   - failClosed (§7.1): when set + the snapshot failed, return 503 and the
 *     daemon NEVER sees the request (true gate). Default fail-open forwards
 *     and relies on the guard event warning.
 *   - Streaming responses (logs follow, build output) and chunked encoding
 *     pass through verbatim; HTTP Upgrade/hijack (exec/attach) is piped raw
 *     both ways so `docker exec` keeps working.
 *
 * Reuses the SAME guard() core as the floor/MCP — the proxy is just another
 * interception front-end, never a parallel snapshot engine (§5).
 *
 * Lifecycle is start()/stop(); errors never crash the main process (logged +
 * 502/503 to the client). Behind DRK_GUARD_PROXY=1 (and DRK_PRUNE_GUARD=1).
 *
 * WINDOWS: named-pipe listening is out of scope (see start()). The supported
 * Windows path is Docker Desktop users running agents in containers and
 * bind-mounting this proxy's unix socket into the agent container in place of
 * /var/run/docker.sock — documented in docs/PRUNE_GUARD_GUIDE.md.
 */

export interface GuardProxyDeps {
  guard: PruneGuardService
  docker: DockerService
  settings: SettingsService
  audit: AuditService
  /** App data dir; the default socket lives at `<dataDir>/drk-guard.sock`. */
  dataDir: string
}

/** New audit action — string literal so we don't have to edit GuardTypes.ts
 *  (out of scope). Mirrors the guard.* namespace (§13). */
const GUARD_PROXY_BLOCKED = 'guard.proxy_blocked'

/** How we reach the REAL daemon — same resolution DockerService uses. */
function upstreamTarget(): { socketPath?: string; host?: string; port?: number } {
  // DRK_GUARD_PROXY_UPSTREAM lets ops point at a TCP daemon (e.g. tcp://host:port)
  // or an explicit socket; otherwise mirror DockerService's default socketPath.
  const up = process.env.DRK_GUARD_PROXY_UPSTREAM
  if (up) {
    if (up.startsWith('tcp://') || up.startsWith('http://')) {
      const u = new URL(up.replace(/^tcp:/, 'http:'))
      return { host: u.hostname, port: Number(u.port) || 2375 }
    }
    return { socketPath: up.replace(/^unix:\/\//, '') }
  }
  return {
    socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock',
  }
}

export class GuardProxy {
  private server: http.Server | null = null
  private tcpServer: http.Server | null = null
  private readonly socketPath: string
  private readonly tcpPort: number | null
  private readonly upstream = upstreamTarget()
  /** Outbound sockets we opened to the daemon for hijacked exec/attach
   *  upgrades. We destroy these on stop() — closeAllConnections() only reaps a
   *  server's *inbound* sockets, not the proxy's outbound upstream duplex. */
  private readonly upgradeSockets = new Set<net.Socket>()

  constructor(private readonly deps: GuardProxyDeps) {
    this.socketPath =
      process.env.DRK_GUARD_PROXY_SOCKET || path.join(deps.dataDir, 'drk-guard.sock')
    // Presence of the env var enables TCP — not its numeric value, so port '0'
    // (ephemeral, used by tests) still counts as "TCP requested".
    const p = process.env.DRK_GUARD_PROXY_PORT
    this.tcpPort = p !== undefined && p !== '' ? Number(p) : null
  }

  /** Bind the unix socket (and optional 127.0.0.1 TCP). Cleans a stale socket
   *  file first. Never throws out of band — logs + resolves on bind failure so
   *  it can never crash the main process. */
  public async start(): Promise<void> {
    // Windows named-pipe LISTENING is out of scope: Node can't bind an arbitrary
    // AF_UNIX path reliably on Windows and we don't implement \\.\pipe servers.
    // The supported Windows story is the agent-in-a-container bind-mount (docs).
    if (process.platform === 'win32' && this.tcpPort === null) {
      logger.warn(
        '[GuardProxy] Windows host without DRK_GUARD_PROXY_PORT: unix-socket ' +
          'listening is unsupported on Windows. Run your agent in a container ' +
          'and bind-mount the proxy socket, or set DRK_GUARD_PROXY_PORT. Skipping.',
      )
      return
    }

    // Unix-socket bind is the primary path on Linux / the Docker Desktop VM.
    // On Windows we skip it (unreliable AF_UNIX) and rely on TCP, which the
    // win32-without-port guard above already ensured is set.
    if (process.platform !== 'win32') {
      this.server = this.makeServer()
      this.server.on('error', err => logger.error({ err }, '[GuardProxy] unix listener error'))
      try {
        // Stale socket from a previous crash → unlink before bind (EADDRINUSE).
        await fs.remove(this.socketPath).catch(() => {})
        await new Promise<void>((resolve, reject) => {
          this.server!.once('error', reject)
          this.server!.listen(this.socketPath, () => {
            this.server!.off('error', reject)
            resolve()
          })
        })
        // Best-effort world-rw so a bind-mounting agent container (different uid)
        // can connect — mirrors index.ts's 0o777 on the DRK guest socket.
        try { await fs.chmod(this.socketPath, 0o777) } catch { /* perms */ }
        logger.info({ socket: this.socketPath }, '[GuardProxy] listening on unix socket')
      } catch (err) {
        logger.error({ err, socket: this.socketPath }, '[GuardProxy] failed to bind unix socket')
        this.server = null
      }
    }

    if (this.tcpPort !== null) {
      this.tcpServer = this.makeServer()
      this.tcpServer.on('error', err => logger.error({ err }, '[GuardProxy] tcp listener error'))
      try {
        await new Promise<void>((resolve, reject) => {
          this.tcpServer!.once('error', reject)
          // 127.0.0.1 ONLY — never expose the daemon proxy to the network.
          this.tcpServer!.listen(this.tcpPort!, '127.0.0.1', () => {
            this.tcpServer!.off('error', reject)
            resolve()
          })
        })
        logger.info({ port: this.tcpPort }, '[GuardProxy] listening on 127.0.0.1 TCP')
      } catch (err) {
        logger.error({ err, port: this.tcpPort }, '[GuardProxy] failed to bind TCP')
        this.tcpServer = null
      }
    }
  }

  /** Close both listeners and remove the socket file. Safe to call repeatedly.
   *  Forcibly tears down in-flight connections (e.g. a hijacked exec/attach
   *  duplex) so close() can't hang waiting on a long-lived upgrade socket. */
  public async stop(): Promise<void> {
    // Destroy outbound hijack duplexes first (these aren't reaped by either
    // server's closeAllConnections) so the upstream daemon connection drops.
    for (const s of this.upgradeSockets) { try { s.destroy() } catch { /* gone */ } }
    this.upgradeSockets.clear()
    const close = (s: http.Server | null) =>
      new Promise<void>(resolve => {
        if (!s) return resolve()
        // close() stops accepting; closeAllConnections() (Node ≥18.2) then
        // forcibly drops keep-alive AND in-flight/upgraded sockets so the
        // close callback can actually fire. Order matters: close() first.
        s.close(() => resolve())
        try { (s as any).closeAllConnections?.() } catch { /* older node */ }
      })
    await Promise.all([close(this.server), close(this.tcpServer)])
    this.server = null
    this.tcpServer = null
    await fs.remove(this.socketPath).catch(() => {})
  }

  /** For tests/ops introspection. */
  public address(): string | null {
    if (this.tcpServer) {
      const a = this.tcpServer.address()
      if (a && typeof a === 'object') return `127.0.0.1:${a.port}`
    }
    return this.server ? this.socketPath : null
  }

  // -------------------------------------------------------------------------
  // Server wiring
  // -------------------------------------------------------------------------

  private makeServer(): http.Server {
    const server = http.createServer((req, res) => {
      // Never let a handler throw take down the process (§5).
      this.handle(req, res).catch(err => {
        logger.error({ err, url: req.url }, '[GuardProxy] request handler crashed')
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ message: 'guard proxy error', detail: String(err?.message || err) }))
        } else {
          res.destroy()
        }
      })
    })
    // exec/attach use Connection: Upgrade to a raw duplex stream — pipe it.
    // The 'upgrade' socket is a net.Socket for a TCP/unix HTTP server.
    server.on('upgrade', (req, clientSocket, head) =>
      this.handleUpgrade(req, clientSocket as net.Socket, head),
    )
    // Defensive: a raw CONNECT or odd hijack shouldn't kill us.
    server.on('clientError', (err, socket) => {
      logger.warn({ err }, '[GuardProxy] client error')
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* gone */ }
    })
    return server
  }

  // -------------------------------------------------------------------------
  // Request handling: intercept → snapshot → forward
  // -------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { pathname, search } = splitUrl(req.url || '/')
    const method = (req.method || 'GET').toUpperCase()
    const intercept = matchDestructive(method, pathname, search)

    if (intercept) {
      try {
        const volumes = await this.resolveTargets(intercept)
        if (volumes.length) {
          const ev = await this.deps.guard.guard(intercept.kind, 'proxy', volumes)
          // failClosed gate (§7.1): if anything we tried to save failed/was
          // skipped-too-large, do NOT forward — block with a 503 so the daemon
          // never destroys data we couldn't protect. Only when the user opted in.
          const settings = await this.deps.settings.getGuardSettings().catch(() => null)
          if (settings?.failClosed && ev.status !== 'saved') {
            await this.deps.audit.record(GUARD_PROXY_BLOCKED, {
              eventId: ev.id,
              kind: intercept.kind,
              volumes,
              status: ev.status,
            })
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({
                message:
                  'Prune Guard (fail-closed): could not snapshot all target volumes; ' +
                  'destructive request blocked. Free disk / raise the per-volume cap and retry.',
                guardEventId: ev.id,
                status: ev.status,
              }),
            )
            return
          }
        }
      } catch (err) {
        // guard() is fail-open and shouldn't throw; resolution might. In
        // fail-closed mode an unexpected error is treated as "couldn't protect".
        const settings = await this.deps.settings.getGuardSettings().catch(() => null)
        logger.error({ err, kind: intercept.kind }, '[GuardProxy] interception failed')
        if (settings?.failClosed) {
          await this.deps.audit.record(GUARD_PROXY_BLOCKED, {
            kind: intercept.kind,
            reason: String((err as any)?.message || err),
          })
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ message: 'Prune Guard (fail-closed): snapshot errored; request blocked.' }))
          return
        }
        // fail-open: fall through and forward.
      }
    }

    this.forward(req, res)
  }

  /** Plain reverse-proxy of one request/response, streaming both bodies. */
  private forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const upstreamReq = http.request(this.upstreamOpts(req), upstreamRes => {
      // Mirror status + headers verbatim (chunked encoding, content-type,
      // streaming framing all preserved).
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstreamReq.on('error', err => {
      logger.error({ err, url: req.url }, '[GuardProxy] upstream request error')
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'cannot reach docker daemon', detail: String(err?.message || err) }))
      } else {
        res.destroy()
      }
    })
    // Stream the client body to the daemon (handles POST build context, etc.).
    req.pipe(upstreamReq)
    req.on('error', () => upstreamReq.destroy())
  }

  /** HTTP Upgrade (exec/attach): open a raw upstream connection, replay the
   *  upgrade request, then pipe the two duplex sockets together both ways. */
  private handleUpgrade(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    clientSocket.on('error', () => { /* swallow — peer hung up */ })
    // Track the inbound (client) socket immediately — Node detaches an upgraded
    // socket from the server's connection set, so server.close() won't wait on
    // it; we must destroy it ourselves on stop() (and when its peer dies).
    this.upgradeSockets.add(clientSocket)
    const opts = this.upstreamOpts(req)
    const upstreamReq = http.request(opts)
    upstreamReq.on('error', err => {
      logger.error({ err, url: req.url }, '[GuardProxy] upstream upgrade error')
      this.upgradeSockets.delete(clientSocket)
      try { clientSocket.end() } catch { /* gone */ }
    })
    // 'upgrade' fires once the daemon accepts the hijack and hands back a socket.
    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      upstreamSocket.on('error', () => { /* swallow */ })
      // Track both ends + tear the peer down when either closes, so a finished
      // exec/attach frees both sockets and stop() can reap any survivors.
      this.upgradeSockets.add(upstreamSocket)
      upstreamSocket.on('close', () => {
        this.upgradeSockets.delete(upstreamSocket)
        try { clientSocket.destroy() } catch { /* gone */ }
      })
      clientSocket.on('close', () => {
        this.upgradeSockets.delete(clientSocket)
        try { upstreamSocket.destroy() } catch { /* gone */ }
      })
      // Replay the daemon's 101 response line + headers to the client.
      const headers = Object.entries(upstreamRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n')
      clientSocket.write(
        `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n${headers}\r\n\r\n`,
      )
      // Flush any bytes that arrived with the upgrade before piping.
      if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead)
      if (head && head.length) upstreamSocket.write(head)
      // Full-duplex raw pipe — this is what makes `docker exec -it` work.
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    })
    upstreamReq.end()
  }

  /** Build http.request options targeting the real daemon, preserving the path
   *  (incl. query string), method, and headers. */
  private upstreamOpts(req: http.IncomingMessage): http.RequestOptions {
    const base: http.RequestOptions = {
      method: req.method,
      path: req.url,
      headers: req.headers,
    }
    if (this.upstream.socketPath) base.socketPath = this.upstream.socketPath
    else { base.host = this.upstream.host; base.port = this.upstream.port }
    return base
  }

  // -------------------------------------------------------------------------
  // Target resolution — ask the daemon what the op WOULD destroy (conservative)
  // -------------------------------------------------------------------------

  /** Resolve the named volumes a matched destructive op is about to destroy. We
   *  query the REAL daemon (the same source of truth it will act on) and filter
   *  conservatively; PruneGuardService.guard() applies the scope filter again. */
  private async resolveTargets(m: DestructiveMatch): Promise<string[]> {
    switch (m.op) {
      case 'volume_rm':
        // DELETE /volumes/{name}
        return m.name ? [m.name] : []

      case 'volume_prune': {
        // POST /volumes/prune removes UNUSED volumes. Be conservative: list
        // volumes, keep named ones with RefCount === 0 (the daemon's own dangle
        // signal). Over-inclusion here only means an extra snapshot, never data
        // loss; under-inclusion would miss a save, so we err toward snapshotting.
        const vols = await this.daemonListVolumes()
        return vols
          .filter(v => !isAnonymous(v.Name) && refCount(v) === 0)
          .map(v => v.Name)
      }

      case 'container_rm_v': {
        // DELETE /containers/{id}?v=1 — reaps the container's named (and
        // in-scope anonymous) volumes. Inspect first to map mounts → volumes.
        if (!m.name) return []
        const info = await this.daemonInspectContainer(m.name).catch(() => null)
        return mountVolumeNames(info)
      }

      case 'container_prune': {
        // POST /containers/prune removes STOPPED containers. Snapshot their
        // named volumes conservatively (inspect each stopped container).
        const stopped = await this.daemonListContainers().catch(() => [])
        const out = new Set<string>()
        for (const c of stopped) {
          if (!isStopped(c)) continue
          const info = await this.daemonInspectContainer(c.Id).catch(() => null)
          for (const n of mountVolumeNames(info)) out.add(n)
        }
        return Array.from(out)
      }

      default:
        return []
    }
  }

  // --- tiny daemon JSON GET helpers (dependency-free) ----------------------

  private daemonListVolumes(): Promise<Array<{ Name: string; UsageData?: any }>> {
    return this.daemonGet('/volumes').then(j => (j && j.Volumes) || [])
  }
  private daemonListContainers(): Promise<any[]> {
    return this.daemonGet('/containers/json?all=1').then(j => j || [])
  }
  private daemonInspectContainer(id: string): Promise<any> {
    return this.daemonGet(`/containers/${encodeURIComponent(id)}/json`)
  }

  private daemonGet(apiPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions = { method: 'GET', path: apiPath, headers: { host: 'docker' } }
      if (this.upstream.socketPath) opts.socketPath = this.upstream.socketPath
      else { opts.host = this.upstream.host; opts.port = this.upstream.port }
      const r = http.request(opts, res => {
        let buf = ''
        res.on('data', c => (buf += c))
        res.on('end', () => {
          if ((res.statusCode || 500) >= 400) return reject(new Error(`daemon ${apiPath} → ${res.statusCode}`))
          try { resolve(buf ? JSON.parse(buf) : null) } catch (e) { reject(e) }
        })
      })
      r.on('error', reject)
      r.end()
    })
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

import type { GuardOpKind } from '@docker-rescue-kit/shared'

/** Internal op discriminator. Distinct from GuardOpKind because the Engine API
 *  has a `container prune` op that maps onto the existing 'container_rm_v'
 *  GuardOpKind (both reap a container's volumes) — `op` drives resolution,
 *  `kind` is what we hand guard()/audit. */
export type DestructiveOp = 'volume_rm' | 'volume_prune' | 'container_rm_v' | 'container_prune'

export interface DestructiveMatch {
  op: DestructiveOp
  /** GuardOpKind reported to guard()/audit (the shared-types vocabulary). */
  kind: GuardOpKind
  /** volume name / container id for the single-target ops. */
  name?: string
}

/** Match a request to a destructive Engine-API op (snapshot-first), tolerating
 *  the versioned `/v1.4x/...` path prefix the CLI/SDK send. Returns null for
 *  everything else (forwarded untouched, zero added latency). §4b allowlist. */
export function matchDestructive(method: string, pathname: string, search: string): DestructiveMatch | null {
  // The matcher is the gate: anything it returns null for is forwarded to the
  // daemon WITHOUT a snapshot. So normalize aggressively before matching, or an
  // agent slips a destructive op past us with a cosmetic path/query variation
  // (`//volumes/x`, `/volumes/x/`, `?v=0&v=1`) that the daemon still honors.
  let p = pathname.replace(/^\/v[0-9]+\.[0-9]+/, '') // strip /v1.4x prefix
  p = p.replace(/\/{2,}/g, '/')                       // collapse repeated slashes
  if (p.length > 1) p = p.replace(/\/+$/, '')          // strip trailing slash(es)
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)

  // Treat a flag as set if ANY of its repeated values is truthy — Docker's query
  // parser can honor the last value where URLSearchParams.get() returns the first,
  // so `?v=0&v=1` must be read as destructive, not as the leading `0`.
  const flagTruthy = (key: string): boolean =>
    q.getAll(key).some(val => { const s = val.toLowerCase(); return s === '1' || s === 'true' })

  if (method === 'DELETE') {
    let mm = /^\/volumes\/([^/]+)$/.exec(p)
    if (mm) return { op: 'volume_rm', kind: 'volume_rm', name: decodeURIComponent(mm[1]) }
    mm = /^\/containers\/([^/]+)$/.exec(p)
    if (mm) {
      // Only `v` reaps the container's anonymous volumes; `force` just kills a
      // running container and never removes named/anonymous volumes, so we do
      // NOT snapshot on `force` alone (would fire false "we saved your work").
      if (flagTruthy('v')) {
        return { op: 'container_rm_v', kind: 'container_rm_v', name: decodeURIComponent(mm[1]) }
      }
      return null // rm without -v doesn't reap named volumes
    }
  }
  if (method === 'POST') {
    if (p === '/volumes/prune') return { op: 'volume_prune', kind: 'volume_prune' }
    // container prune reaps a container's volumes → same GuardOpKind as rm -v.
    if (p === '/containers/prune') return { op: 'container_prune', kind: 'container_rm_v' }
  }
  return null
}

/** A volume's RefCount from `GET /volumes` UsageData (-1 = unknown → treat as
 *  not-prunable so we don't over-snapshot; 0 = dangling → prune candidate). */
export function refCount(v: { UsageData?: { RefCount?: number } | null }): number {
  const rc = v.UsageData?.RefCount
  return typeof rc === 'number' ? rc : -1
}

/** Named volume names mounted into a container (anonymous + binds excluded). */
export function mountVolumeNames(info: any): string[] {
  const mounts: any[] = info?.Mounts || []
  const names = mounts
    .filter(m => m?.Type === 'volume' && typeof m?.Name === 'string' && m.Name && !isAnonymous(m.Name))
    .map(m => m.Name as string)
  return Array.from(new Set(names))
}

function isStopped(c: any): boolean {
  const s = String(c?.State || '').toLowerCase()
  return s !== 'running' && s !== 'paused' && s !== 'restarting'
}

function splitUrl(url: string): { pathname: string; search: string } {
  const i = url.indexOf('?')
  return i < 0 ? { pathname: url, search: '' } : { pathname: url.slice(0, i), search: url.slice(i) }
}

/** Anonymous Docker volumes are named with a 64-char lowercase hex id. */
function isAnonymous(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name)
}
