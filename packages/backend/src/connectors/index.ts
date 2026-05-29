import { ConnectorRegistry } from './ConnectorRegistry'
import { ProxmoxConnector } from './ProxmoxConnector'
import { TrueNASConnector } from './TrueNASConnector'
import { S3Connector } from './S3Connector'
import { SFTPConnector } from './SFTPConnector'
import { RcloneConnector } from './RcloneConnector'
import { PBSConnector } from './PBSConnector'
import { SMBConnector } from './SMBConnector'

export * from './base'
export * from './ConnectorRegistry'

// Register built-in connectors (discovery + storage both use this registry).
ConnectorRegistry.register(new ProxmoxConnector())
ConnectorRegistry.register(new TrueNASConnector())
ConnectorRegistry.register(new S3Connector())
ConnectorRegistry.register(new SFTPConnector())
ConnectorRegistry.register(new RcloneConnector())
ConnectorRegistry.register(new PBSConnector())
ConnectorRegistry.register(new SMBConnector())
