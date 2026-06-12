import { EventEmitter } from 'events'
import { GuardMonitor } from '../services/GuardMonitor'

// A controllable fake Docker events stream — a readable-ish EventEmitter with a
// destroy() so the monitor can tear it down.
class FakeStream extends EventEmitter {
  destroyed = false
  destroy() {
    this.destroyed = true
    this.emit('close')
  }
  /** Push one newline-delimited JSON event line. */
  push(obj: any) {
    this.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  }
}

class FakeDockerode {
  stream = new FakeStream()
  getEventsErr: any = null
  inspectResult: any = { Mounts: [] }
  inspectThrows = false

  getEvents(_opts: any, cb: (err: any, stream: any) => void) {
    if (this.getEventsErr) return cb(this.getEventsErr, null)
    // Fresh stream per subscription so reconnects don't accumulate handlers on
    // a single emitter (mirrors dockerode handing back a new stream each call).
    this.stream = new FakeStream()
    cb(null, this.stream)
  }
  getContainer(_id: string) {
    return {
      inspect: async () => {
        if (this.inspectThrows) throw new Error('container gone')
        return this.inspectResult
      },
    }
  }
}

class FakeDockerService {
  docker = new FakeDockerode()
  volumes: Array<{ Name: string }> = []
  async listVolumes() {
    return this.volumes
  }
}

class FakeSettings {
  current: any = {
    enabled: true,
    scope: 'named',
    diskBudgetMb: 2048,
    perVolumeCapMb: 512,
    ttlHours: 72,
    periodicCron: '0 */6 * * *',
    failClosed: false,
  }
  async getGuardSettings() {
    return this.current
  }
}

class FakeGuard {
  guarded: Array<{ kind: string; trigger: string; volumes: string[] }> = []
  tooLate: string[] = []
  floors: string[][] = []
  swept = 0
  async guard(kind: string, trigger: string, volumes: string[]) {
    this.guarded.push({ kind, trigger, volumes })
    return {} as any
  }
  async recordTooLate(volume: string) {
    this.tooLate.push(volume)
    return { floorSnapshotAgeHours: null, eventId: null }
  }
  async floorSnapshot(volumes: string[]) {
    this.floors.push(volumes)
    return {} as any
  }
  async sweepExpired() {
    this.swept++
    return { expired: 0, reclaimedBytes: 0 }
  }
}

function build() {
  const docker = new FakeDockerService()
  const settings = new FakeSettings()
  const guard = new FakeGuard()
  const monitor = new GuardMonitor({ docker: docker as any, settings: settings as any, guard: guard as any })
  return { docker, settings, guard, monitor }
}

const flush = () => new Promise(r => setImmediate(r))

afterEach(() => {
  jest.useRealTimers()
})

// ---------------------------------------------------------------------------

describe('GuardMonitor — Docker events stream', () => {
  it('container die → guard() called with the container\'s resolved named volumes', async () => {
    const { docker, guard, monitor } = build()
    docker.docker.inspectResult = {
      Mounts: [
        { Type: 'volume', Name: 'pg-data' },
        { Type: 'volume', Name: 'redis-data' },
        { Type: 'bind', Name: '' }, // bind mounts are excluded
        { Type: 'volume', Name: 'pg-data' }, // dup, de-duped
      ],
    }
    await monitor.start()
    docker.docker.stream.push({ Type: 'container', Action: 'die', Actor: { ID: 'c1' } })
    await flush()
    await flush()

    expect(guard.guarded.length).toBe(1)
    expect(guard.guarded[0].kind).toBe('container_die')
    expect(guard.guarded[0].trigger).toBe('event')
    expect(guard.guarded[0].volumes.sort()).toEqual(['pg-data', 'redis-data'])
    monitor.stop()
  })

  it('container die with no named volumes → guard() NOT called', async () => {
    const { docker, guard, monitor } = build()
    docker.docker.inspectResult = { Mounts: [{ Type: 'bind', Name: '' }] }
    await monitor.start()
    docker.docker.stream.push({ Type: 'container', Action: 'die', Actor: { ID: 'c1' } })
    await flush()
    await flush()
    expect(guard.guarded.length).toBe(0)
    monitor.stop()
  })

  it('volume destroy → recordTooLate(volume)', async () => {
    const { docker, guard, monitor } = build()
    await monitor.start()
    docker.docker.stream.push({ Type: 'volume', Action: 'destroy', Actor: { ID: 'pocketos-db' } })
    await flush()
    await flush()
    expect(guard.tooLate).toEqual(['pocketos-db'])
    monitor.stop()
  })

  it('stream error → reconnect scheduled (getEvents re-invoked)', async () => {
    jest.useFakeTimers()
    const { docker, monitor } = build()
    const spy = jest.spyOn(docker.docker, 'getEvents')
    await monitor.start()
    expect(spy).toHaveBeenCalledTimes(1)

    // Simulate a stream error → backoff timer scheduled.
    docker.docker.stream.emit('error', new Error('boom'))
    // First backoff is RECONNECT_BASE_MS (1000ms).
    jest.advanceTimersByTime(1000)
    expect(spy).toHaveBeenCalledTimes(2)
    monitor.stop()
  })
})

// ---------------------------------------------------------------------------

describe('GuardMonitor — periodic floor', () => {
  it('floor tick → floorSnapshot over the named (non-anonymous) volume set', async () => {
    const { docker, guard, monitor } = build()
    docker.volumes = [
      { Name: 'app-data' },
      { Name: 'cache' },
      { Name: 'a'.repeat(64) }, // anonymous 64-hex → excluded
    ]
    await monitor.runFloorTick()
    expect(guard.floors.length).toBe(1)
    expect(guard.floors[0].sort()).toEqual(['app-data', 'cache'])
    void monitor
  })

  it('floor tick is a no-op when scope=off', async () => {
    const { settings, guard, monitor } = build()
    settings.current.scope = 'off'
    await monitor.runFloorTick()
    expect(guard.floors.length).toBe(0)
    void monitor
  })

  it('floor tick is a no-op when the guard is disabled', async () => {
    const { settings, guard, monitor } = build()
    settings.current.enabled = false
    await monitor.runFloorTick()
    expect(guard.floors.length).toBe(0)
    void monitor
  })
})

// ---------------------------------------------------------------------------

describe('GuardMonitor — TTL sweep', () => {
  it('daily interval fires sweepExpired()', async () => {
    const { docker, settings, guard, monitor } = build()
    // Isolate the daily sweep setInterval from the other two jobs:
    //  - make getEvents a no-op so the events stream + reconnect timers never run;
    //  - invalidate the floor cron so node-cron's per-second internal ticks don't
    //    churn when we advance a full day under fake timers.
    jest.spyOn(docker.docker, 'getEvents').mockImplementation(() => {})
    settings.current.periodicCron = 'not-a-cron'
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    await monitor.start()
    // Advance one day → one sweep. Async variant flushes the microtask queue
    // between fired timers so the awaited sweepExpired() settles.
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(guard.swept).toBe(1)
    monitor.stop()
  })
})
