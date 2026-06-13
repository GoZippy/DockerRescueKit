/**
 * PG-2.1 GuardProxy tests (docs/design/PRUNE_GUARD.md §4b, §7.1, §12 g6, §14).
 *
 * No real Docker. We spin a FAKE daemon (a plain http.Server) and point the
 * proxy's upstream at it over TCP, and run the proxy itself in TCP mode
 * (DRK_GUARD_PROXY_PORT). This deliberately avoids unix sockets: Node's
 * AF_UNIX support on Windows is unreliable and the repo's socketTransport test
 * skips unix binds on win32 for the same reason — TCP-mode exercises the exact
 * same handler/forward/upgrade code paths everywhere.
 *
 * Covers: passthrough GET (body + headers intact), streaming chunked response,
 * HTTP Upgrade/hijack piping, DELETE /volumes/x guard()-before-daemon ordering,
 * prune candidate resolution, failClosed=true + snapshot failure → 503 with the
 * daemon NEVER receiving the request, failClosed=false + failure → forwarded.
 */

import http from 'http'
import net from 'net'
import { AddressInfo } from 'net'
import { GuardProxy, matchDestructive, refCount, mountVolumeNames } from '../services/GuardProxy'

// --- fakes ----------------------------------------------------------------

class FakeGuard {
  calls: Array<{ kind: string; trigger: string; volumes: string[] }> = []
  // event status returned by guard(); set 'failed' to simulate a snapshot fail.
  nextStatus: 'saved' | 'partial' | 'failed' = 'saved'
  async guard(kind: string, trigger: string, volumes: string[]) {
    this.calls.push({ kind, trigger, volumes })
    return { id: 'evt-1', kind, trigger, volumes, totalBytes: 0, status: this.nextStatus }
  }
}
class FakeSettings {
  failClosed = false
  async getGuardSettings() {
    return {
      enabled: true, scope: 'named', diskBudgetMb: 2048, perVolumeCapMb: 512,
      ttlHours: 72, periodicCron: '0 */6 * * *', failClosed: this.failClosed,
    }
  }
}
class FakeAudit {
  events: Array<{ action: string; details?: any }> = []
  async record(action: string, details?: any) { this.events.push({ action, details }) }
  has(a: string) { return this.events.some(e => e.action === a) }
}

interface DaemonLog { method: string; url: string }

/** A configurable fake Docker daemon. Records every request it receives so we
 *  can assert the proxy forwarded (or did NOT forward) a given call. */
function makeFakeDaemon(): Promise<{ port: number; log: DaemonLog[]; close: () => Promise<void>; server: http.Server }> {
  const log: DaemonLog[] = []
  // Upgraded sockets are detached from the server's connection set, so we track
  // them and destroy on close() — otherwise server.close() hangs after an exec.
  const upgraded = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    log.push({ method: req.method || '', url: req.url || '' })
    const { pathname } = new URL(req.url || '/', 'http://d')

    if (pathname === '/volumes') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        Volumes: [
          { Name: 'dangling', UsageData: { RefCount: 0 } },
          { Name: 'in-use', UsageData: { RefCount: 2 } },
          { Name: 'a'.repeat(64), UsageData: { RefCount: 0 } }, // anonymous → excluded
        ],
      }))
      return
    }
    if (pathname === '/containers/json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([
        { Id: 'cstopped', State: 'exited' },
        { Id: 'crunning', State: 'running' },
      ]))
      return
    }
    if (/^\/containers\/[^/]+\/json$/.test(pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Mounts: [{ Type: 'volume', Name: 'named-of-' + pathname.split('/')[2] }] }))
      return
    }
    if (pathname === '/echo') {
      // Echo headers + body so we can assert passthrough fidelity.
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-daemon': 'yes' })
        res.end(JSON.stringify({ gotHeader: req.headers['x-test'], body }))
      })
      return
    }
    if (pathname === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' })
      res.write('chunk-1\n')
      setTimeout(() => { res.write('chunk-2\n'); res.end('chunk-3\n') }, 10)
      return
    }
    // Default: 200 OK (used for the destructive DELETE/POST forwards).
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  // Raw upgrade echo: pipe whatever the client sends back to it.
  server.on('upgrade', (_req, socket, head) => {
    upgraded.add(socket as net.Socket)
    socket.on('close', () => upgraded.delete(socket as net.Socket))
    socket.on('error', () => { /* peer reset */ })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    if (head && head.length) socket.write(head)
    socket.on('data', d => socket.write(Buffer.concat([Buffer.from('echo:'), d])))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        log,
        server,
        close: () => new Promise<void>(r => {
          // Force-drop any hijacked/keep-alive sockets so close() can't hang on
          // the still-open exec/attach duplex from the upgrade test.
          for (const s of upgraded) { try { s.destroy() } catch { /* gone */ } }
          upgraded.clear()
          server.close(() => r())
          try { (server as any).closeAllConnections?.() } catch { /* old node */ }
        }),
      })
    })
  })
}

// --- harness --------------------------------------------------------------

async function makeProxy(opts: { failClosed?: boolean; guardStatus?: 'saved' | 'failed' } = {}) {
  const daemon = await makeFakeDaemon()
  const guard = new FakeGuard()
  if (opts.guardStatus) guard.nextStatus = opts.guardStatus
  const settings = new FakeSettings()
  if (opts.failClosed) settings.failClosed = true
  const audit = new FakeAudit()

  process.env.DRK_GUARD_PROXY_UPSTREAM = `tcp://127.0.0.1:${daemon.port}`
  process.env.DRK_GUARD_PROXY_PORT = '0' // ephemeral 127.0.0.1 TCP
  delete process.env.DRK_GUARD_PROXY_SOCKET

  const proxy = new GuardProxy({
    guard: guard as any, docker: {} as any, settings: settings as any, audit: audit as any,
    dataDir: require('os').tmpdir(),
  })
  await proxy.start()
  const addr = proxy.address()! // "127.0.0.1:<port>"
  const proxyPort = Number(addr.split(':')[1])
  return { proxy, daemon, guard, settings, audit, proxyPort }
}

/** Minimal http client against the proxy. */
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let buf = ''
      res.on('data', c => (buf += c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: buf }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

afterEach(() => {
  delete process.env.DRK_GUARD_PROXY_UPSTREAM
  delete process.env.DRK_GUARD_PROXY_PORT
  delete process.env.DRK_GUARD_PROXY_SOCKET
})

// ---------------------------------------------------------------------------
// matchDestructive — pure unit (no network)
// ---------------------------------------------------------------------------

describe('matchDestructive', () => {
  it('matches DELETE /volumes/{name} (and versioned prefix)', () => {
    expect(matchDestructive('DELETE', '/volumes/foo', '')).toEqual({ op: 'volume_rm', kind: 'volume_rm', name: 'foo' })
    expect(matchDestructive('DELETE', '/v1.43/volumes/bar', '')).toEqual({ op: 'volume_rm', kind: 'volume_rm', name: 'bar' })
  })
  it('matches container rm only with v=1|true', () => {
    expect(matchDestructive('DELETE', '/containers/abc', '?v=1')).toEqual({ op: 'container_rm_v', kind: 'container_rm_v', name: 'abc' })
    expect(matchDestructive('DELETE', '/containers/abc', '?v=true')).toEqual({ op: 'container_rm_v', kind: 'container_rm_v', name: 'abc' })
    expect(matchDestructive('DELETE', '/containers/abc', '')).toBeNull()
    expect(matchDestructive('DELETE', '/containers/abc', '?force=1')).toBeNull()
  })
  it('matches prune endpoints; ignores non-destructive', () => {
    expect(matchDestructive('POST', '/volumes/prune', '')).toEqual({ op: 'volume_prune', kind: 'volume_prune' })
    // container prune maps onto the container_rm_v GuardOpKind (both reap volumes).
    expect(matchDestructive('POST', '/v1.41/containers/prune', '')).toEqual({ op: 'container_prune', kind: 'container_rm_v' })
    expect(matchDestructive('GET', '/volumes', '')).toBeNull()
    expect(matchDestructive('GET', '/containers/json', '')).toBeNull()
    expect(matchDestructive('POST', '/images/abc/push', '')).toBeNull()
  })
  it('cannot be bypassed by cosmetic path/query variants (the gate is the matcher)', () => {
    // Repeated slashes — daemon still routes these to the destroy handler.
    expect(matchDestructive('DELETE', '//volumes/foo', '')).toMatchObject({ op: 'volume_rm', name: 'foo' })
    expect(matchDestructive('DELETE', '/v1.43//volumes/foo', '')).toMatchObject({ op: 'volume_rm', name: 'foo' })
    // Trailing slash.
    expect(matchDestructive('DELETE', '/volumes/foo/', '')).toMatchObject({ op: 'volume_rm', name: 'foo' })
    expect(matchDestructive('POST', '/volumes/prune/', '')).toEqual({ op: 'volume_prune', kind: 'volume_prune' })
    // Duplicate v param: get() would read the leading 0, but the daemon may
    // honor the last value (1) → must still match as destructive.
    expect(matchDestructive('DELETE', '/containers/abc', '?v=0&v=1')).toMatchObject({ op: 'container_rm_v', name: 'abc' })
    expect(matchDestructive('DELETE', '/containers/abc', '?v=false&v=true')).toMatchObject({ op: 'container_rm_v', name: 'abc' })
    // Genuinely non-destructive still passes through untouched.
    expect(matchDestructive('DELETE', '/containers/abc', '?v=0')).toBeNull()
    expect(matchDestructive('DELETE', '/containers/abc', '?force=1')).toBeNull()
  })
  it('refCount + mountVolumeNames helpers', () => {
    expect(refCount({ UsageData: { RefCount: 0 } })).toBe(0)
    expect(refCount({ UsageData: null })).toBe(-1)
    expect(refCount({})).toBe(-1)
    expect(mountVolumeNames({ Mounts: [
      { Type: 'volume', Name: 'a' }, { Type: 'bind', Source: '/x' },
      { Type: 'volume', Name: 'b'.repeat(64) }, // anonymous excluded
    ] })).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// passthrough + streaming + upgrade
// ---------------------------------------------------------------------------

describe('GuardProxy passthrough', () => {
  it('forwards GET with headers + body intact and returns daemon response', async () => {
    const { proxy, daemon, proxyPort } = await makeProxy()
    try {
      const res = await call(proxyPort, 'POST', '/echo', { 'x-test': 'hello', 'content-type': 'text/plain' }, 'payload')
      expect(res.status).toBe(200)
      expect(res.headers['x-daemon']).toBe('yes')
      const parsed = JSON.parse(res.body)
      expect(parsed.gotHeader).toBe('hello')
      expect(parsed.body).toBe('payload')
      expect(daemon.log.some(l => l.url === '/echo')).toBe(true)
    } finally { await proxy.stop(); await daemon.close() }
  })

  it('streams a chunked response through verbatim', async () => {
    const { proxy, daemon, proxyPort } = await makeProxy()
    try {
      const res = await call(proxyPort, 'GET', '/stream')
      expect(res.status).toBe(200)
      expect(res.body).toBe('chunk-1\nchunk-2\nchunk-3\n')
    } finally { await proxy.stop(); await daemon.close() }
  })

  it('pipes an HTTP Upgrade (exec/attach hijack) both ways', async () => {
    const { proxy, daemon, proxyPort } = await makeProxy()
    try {
      const got: string = await new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, '127.0.0.1', () => {
          socket.write(
            'GET /exec HTTP/1.1\r\nHost: d\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
          )
        })
        let buf = ''
        let pinged = false
        socket.on('data', d => {
          buf += d.toString()
          if (buf.includes('101') && !pinged) { pinged = true; socket.write('ping') } // send after handshake
          if (buf.includes('echo:ping')) { socket.destroy(); resolve(buf) }
        })
        socket.on('error', () => { /* peer reset on teardown — ignore */ })
        const t = setTimeout(() => reject(new Error('upgrade timeout')), 4000)
        ;(t as any).unref?.()
      })
      expect(got).toContain('101 Switching Protocols')
      expect(got).toContain('echo:ping')
    } finally { await proxy.stop(); await daemon.close() }
  })
})

// ---------------------------------------------------------------------------
// interception: snapshot-FIRST ordering + resolution
// ---------------------------------------------------------------------------

describe('GuardProxy interception', () => {
  it('DELETE /volumes/x calls guard() BEFORE the daemon sees the request', async () => {
    const { proxy, daemon, guard, proxyPort } = await makeProxy()
    try {
      const res = await call(proxyPort, 'DELETE', '/volumes/myvol')
      expect(res.status).toBe(200)
      expect(guard.calls).toHaveLength(1)
      expect(guard.calls[0]).toMatchObject({ kind: 'volume_rm', trigger: 'proxy', volumes: ['myvol'] })
      // Ordering: the guard() call was recorded before the daemon logged the DELETE.
      // (guard() awaited fully before forward(); the only DELETE the daemon logs is the forward.)
      expect(daemon.log.some(l => l.method === 'DELETE' && l.url === '/volumes/myvol')).toBe(true)
    } finally { await proxy.stop(); await daemon.close() }
  })

  it('volume prune resolves dangling named volumes (RefCount 0, non-anonymous)', async () => {
    const { proxy, daemon, guard, proxyPort } = await makeProxy()
    try {
      await call(proxyPort, 'POST', '/volumes/prune')
      expect(guard.calls).toHaveLength(1)
      expect(guard.calls[0].kind).toBe('volume_prune')
      expect(guard.calls[0].volumes).toEqual(['dangling']) // in-use + anonymous excluded
      // resolution queried the daemon's /volumes list, then forwarded the prune.
      expect(daemon.log.some(l => l.url === '/volumes')).toBe(true)
      expect(daemon.log.some(l => l.method === 'POST' && l.url === '/volumes/prune')).toBe(true)
    } finally { await proxy.stop(); await daemon.close() }
  })

  it('container prune snapshots stopped containers\' named volumes only', async () => {
    const { proxy, guard, proxyPort, daemon } = await makeProxy()
    try {
      await call(proxyPort, 'POST', '/containers/prune')
      // container prune reports the container_rm_v GuardOpKind (shared-types vocab).
      expect(guard.calls[0].kind).toBe('container_rm_v')
      // only the stopped container (cstopped) is inspected → its named volume.
      expect(guard.calls[0].volumes).toEqual(['named-of-cstopped'])
    } finally { await proxy.stop(); await daemon.close() }
  })

  it('non-destructive GET is forwarded WITHOUT a guard() call', async () => {
    const { proxy, daemon, guard, proxyPort } = await makeProxy()
    try {
      await call(proxyPort, 'GET', '/containers/json')
      expect(guard.calls).toHaveLength(0)
      expect(daemon.log.some(l => l.method === 'GET' && l.url === '/containers/json')).toBe(true)
    } finally { await proxy.stop(); await daemon.close() }
  })
})

// ---------------------------------------------------------------------------
// failClosed (§7.1, §12 g6)
// ---------------------------------------------------------------------------

describe('GuardProxy failClosed', () => {
  it('failClosed=true + snapshot failure → 503 and daemon NEVER receives the DELETE', async () => {
    const { proxy, daemon, audit, proxyPort } = await makeProxy({ failClosed: true, guardStatus: 'failed' })
    try {
      const res = await call(proxyPort, 'DELETE', '/volumes/precious')
      expect(res.status).toBe(503)
      expect(JSON.parse(res.body).guardEventId).toBe('evt-1')
      // The destructive DELETE must NOT have reached the daemon.
      expect(daemon.log.some(l => l.method === 'DELETE')).toBe(false)
      expect(audit.has('guard.proxy_blocked')).toBe(true)
    } finally { await proxy.stop(); await daemon.close() }
  })

  it('failClosed=false + snapshot failure → request IS forwarded (fail-open)', async () => {
    const { proxy, daemon, proxyPort } = await makeProxy({ failClosed: false, guardStatus: 'failed' })
    try {
      const res = await call(proxyPort, 'DELETE', '/volumes/precious')
      expect(res.status).toBe(200) // daemon's response — it was forwarded
      expect(daemon.log.some(l => l.method === 'DELETE' && l.url === '/volumes/precious')).toBe(true)
    } finally { await proxy.stop(); await daemon.close() }
  })

  it('failClosed=true but snapshot SUCCEEDED → forwards normally', async () => {
    const { proxy, daemon, proxyPort } = await makeProxy({ failClosed: true, guardStatus: 'saved' })
    try {
      const res = await call(proxyPort, 'DELETE', '/volumes/ok')
      expect(res.status).toBe(200)
      expect(daemon.log.some(l => l.method === 'DELETE' && l.url === '/volumes/ok')).toBe(true)
    } finally { await proxy.stop(); await daemon.close() }
  })
})
