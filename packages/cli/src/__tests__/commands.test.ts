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
