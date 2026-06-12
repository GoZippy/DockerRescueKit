import { commands, findCommand } from '../commands'

describe('CLI command registry', () => {
  it('includes the core commands', () => {
    const names = commands.map(c => c.name)
    expect(names).toEqual(expect.arrayContaining([
      'status',
      'policy:list',
      'policy:run',
      'backup:list',
      'backup:restore',
      'backup:verify',
      'backup:delete',
      'stacks',
      'stack:protect',
      'verify:history',
      'connectors:list',
      'connectors:definitions',
      'connectors:test',
      'audit',
      'settings:show',
      'images',
      'networks'
    ]))
  })

  it('includes the rehearsal commands (R-1)', () => {
    const names = commands.map(c => c.name)
    expect(names).toEqual(expect.arrayContaining([
      'rehearsal:start',
      'rehearsal:list',
      'rehearsal:show',
      'rehearsal:abort',
      'rehearsal:delete',
    ]))
  })

  it('includes the day-0 setup commands (v1.4 gap-fill)', () => {
    const names = commands.map(c => c.name)
    expect(names).toEqual(expect.arrayContaining([
      'policy:create',
      'policy:update',
      'policy:template',
      'connector:create',
      'connector:discover',
      'config:export',
      'config:import',
      'license:status',
      'license:activate',
      'health',
    ]))
  })

  it('findCommand resolves by name', () => {
    expect(findCommand('status')?.name).toBe('status')
    expect(findCommand('does-not-exist')).toBeUndefined()
  })

  it('each command has a name, summary, and run function', () => {
    for (const c of commands) {
      expect(typeof c.name).toBe('string')
      expect(typeof c.summary).toBe('string')
      expect(typeof c.run).toBe('function')
    }
  })
})
