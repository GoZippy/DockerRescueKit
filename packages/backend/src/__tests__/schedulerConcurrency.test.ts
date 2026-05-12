import { SchedulerEngine } from '../scheduler/SchedulerEngine'

describe('SchedulerEngine maintenance + concurrency', () => {
  it('pause/resume toggles the paused flag', () => {
    const engine = new SchedulerEngine({} as any)
    expect(engine.isPaused()).toBe(false)
    engine.pause()
    expect(engine.isPaused()).toBe(true)
    engine.resume()
    expect(engine.isPaused()).toBe(false)
  })

  it('runPolicy refuses to overlap itself', async () => {
    let resolveFirst: () => void
    const firstRun = new Promise<void>(r => { resolveFirst = r })
    const policyManager: any = {
      runBackup: jest.fn().mockImplementation(async () => {
        await firstRun
        return { status: 'success' }
      }),
      getPolicy: jest.fn().mockResolvedValue(null)
    }
    const engine = new SchedulerEngine(policyManager)

    const firstPromise = engine.runPolicy('p1')
    // While the first is in flight, a second attempt should throw.
    expect(engine.isInFlight('p1')).toBe(true)
    await expect(engine.runPolicy('p1')).rejects.toThrow(/already.*in flight/i)

    resolveFirst!()
    await firstPromise
    expect(engine.isInFlight('p1')).toBe(false)
  })
})
