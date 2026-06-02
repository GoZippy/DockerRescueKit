import { ConnectorRegistry } from '../connectors/ConnectorRegistry'
import { SMBConnector } from '../connectors/SMBConnector'

describe('SMBConnector', () => {
  let connector: SMBConnector

  beforeAll(() => {
    connector = new SMBConnector()
    ConnectorRegistry.register(connector)
  })

  it('registers with type smb', () => {
    expect(connector.definition.type).toBe('smb')
  })

  it('has display name SMB / CIFS', () => {
    expect(connector.definition.displayName).toBe('SMB / CIFS')
  })

  it('requires host and share fields', () => {
    const required = connector.definition.fields.filter(f => f.required)
    expect(required.map(f => f.name)).toContain('host')
    expect(required.map(f => f.name)).toContain('share')
  })

  it('has optional username, password, domain fields', () => {
    const optional = connector.definition.fields.filter(f => !f.required)
    expect(optional.map(f => 'username'))
    expect(optional.map(f => 'password'))
    expect(optional.map(f => 'domain'))
  })

  it('password field is masked', () => {
    const pwField = connector.definition.fields.find(f => f.name === 'password')
    expect(pwField?.type).toBe('password')
  })

  it('is retrievable from registry', () => {
    const plugin = ConnectorRegistry.getPlugin('smb')
    expect(plugin).toBe(connector)
  })

  it('does not expose discoverDestinations (intentional — needs SYS_ADMIN, deferred to v1.4)', () => {
    // Per DR-001 + the SMB migration: SMB has no destinations enumeration
    // because share discovery requires a mount privilege we cannot assume
    // before the user commits to a target. resolveDiscovery() in
    // ConnectorManager returns [] for connectors without the method.
    expect((connector as any).discoverDestinations).toBeUndefined()
    expect((connector as any).discoverResources).toBeUndefined()
  })

  it('testConnection returns success:false for unreachable host', async () => {
    const result = await connector.testConnection({
      host: '192.0.2.1',
      share: 'test',
    })
    expect(result.success).toBe(false)
  })
})
