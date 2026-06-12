import React, { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import {
  Server, Database, Cloud, Plus, Loader2, Trash2, RefreshCw,
  CheckCircle2, XCircle, AlertCircle, Edit2, Wifi, HardDrive,
} from 'lucide-react'
import { getConnectors, getConnectorInstances, deleteConnectorInstance, testConnector } from '../api'

import { AddConnectorWizard } from './AddConnectorWizard'
import { RcloneWizard } from './RcloneWizard'
import { ConnectorHelp } from './ConnectorHelp'
import { PageError, PageErrorKind } from './PageError'
import { useToast } from '../hooks/useToast'
import { RCLONE_OVERVIEW_HELP } from '../integrationsHelp'

const errorKindFromAxios = (e: unknown): PageErrorKind => {
  if (axios.isAxiosError(e)) {
    if (e.response?.status === 401) return 'auth'
    if (e.response?.status === 503) return 'docker-offline'
  }
  return 'unknown'
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  online: <CheckCircle2 size={14} color="var(--emerald)" />,
  offline: <XCircle size={14} color="var(--rose)" />,
  error: <AlertCircle size={14} color="var(--amber)" />,
  untested: <AlertCircle size={14} color="var(--text-muted)" />,
}

const STATUS_LABEL: Record<string, string> = {
  online: 'Connected',
  offline: 'Offline',
  error: 'Error',
  untested: 'Untested',
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  s3: <Cloud size={18} />,
  smb: <Server size={18} />,
  sftp: <Wifi size={18} />,
  rclone: <Cloud size={18} />,
  proxmox: <HardDrive size={18} />,
  truenas: <Database size={18} />,
  pbs: <Database size={18} />,
  nfs: <Server size={18} />,
}

export const ConnectorsPage: React.FC = () => {
  const [definitions, setDefinitions] = useState<any[]>([])
  const [instances, setInstances] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [errorKind, setErrorKind] = useState<PageErrorKind | null>(null)
  const [showWizard, setShowWizard] = useState<boolean | string>(false)
  const [showRclone, setShowRclone] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const toast = useToast()

  const loadData = useCallback(async () => {
    setErrorKind(null)
    try {
      const [defs, insts] = await Promise.all([
        getConnectors().catch(() => []),
        getConnectorInstances().catch(() => []),
      ])
      setDefinitions(defs)
      setInstances(insts)
    } catch (e) {
      console.error('Failed to load connectors', e)
      setErrorKind(errorKindFromAxios(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleWizardClose = (saved?: boolean) => {
    setShowWizard(false)
    if (saved) {
      toast.push('success', 'Connector saved')
      loadData()
    }
  }

  const handleTest = async (instance: any) => {
    setTesting(instance.id)
    try {
      const res = await testConnector(instance.type, instance.config)
      if (res.success) {
        toast.push('success', `${instance.name} — connection OK`)
        setInstances(prev => prev.map(i => i.id === instance.id ? { ...i, status: 'online', lastTested: new Date() } : i))
      } else {
        toast.push('error', `${instance.name} — connection failed`)
        setInstances(prev => prev.map(i => i.id === instance.id ? { ...i, status: 'error' } : i))
      }
    } catch {
      toast.push('error', `${instance.name} — connection failed`)
      setInstances(prev => prev.map(i => i.id === instance.id ? { ...i, status: 'error' } : i))
    }
    setTesting(null)
  }

  const handleDelete = async (instance: any) => {
    if (!confirm(`Delete "${instance.name}"? This won't remove stored backups.`)) return
    setDeleting(instance.id)
    try {
      await deleteConnectorInstance(instance.id)
      toast.push('success', `${instance.name} deleted`)
      setInstances(prev => prev.filter(i => i.id !== instance.id))
    } catch {
      toast.push('error', `Failed to delete ${instance.name}`)
    }
    setDeleting(null)
  }

  if (errorKind) {
    return (
      <PageError
        kind={errorKind}
        title={errorKind === 'unknown' ? 'Failed to load integrations' : undefined}
        onRetry={() => { setLoading(true); loadData() }}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {showWizard !== false && (
        <AddConnectorWizard
          onClose={() => handleWizardClose()}
          initialType={typeof showWizard === 'string' ? showWizard : undefined}
        />
      )}
      {showRclone && <RcloneWizard onClose={() => { setShowRclone(false); loadData() }} />}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Integrations</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Configure storage backends and remote connectors. Credentials are encrypted at rest with AES-256-GCM.
          </p>
        </div>
      </div>

      {/* Existing instances */}
      {instances.length > 0 && (
        <section>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
            Configured connectors ({instances.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {instances.map(inst => {
              const def = definitions.find(d => d.type === inst.type)
              return (
                <div key={inst.id} className="card" style={{
                  background: 'var(--surface-1)', padding: '10px 14px',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {TYPE_ICON[inst.type] || <Server size={18} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{inst.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {def?.displayName || inst.type}
                      {inst.config?.host ? ` · ${inst.config.host}` : ''}
                      {inst.config?.bucket ? ` · ${inst.config.bucket}` : ''}
                    </div>
                  </div>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                    {STATUS_ICON[inst.status] || STATUS_ICON.untested}
                    {STATUS_LABEL[inst.status] || 'Unknown'}
                  </span>
                  {inst.lastTested && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {new Date(inst.lastTested).toLocaleDateString()}
                    </span>
                  )}
                  <button
                    className="btn btn-ghost" style={{ padding: '4px 8px' }}
                    onClick={() => handleTest(inst)}
                    disabled={testing === inst.id}
                    title="Test connection"
                  >
                    {testing === inst.id
                      ? <Loader2 size={13} className="animate-spin" />
                      : <RefreshCw size={13} />
                    }
                  </button>
                  <button
                    className="btn btn-ghost" style={{ padding: '4px 8px' }}
                    onClick={() => setShowWizard(inst.type)}
                    title="Add another"
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    className="btn btn-ghost" style={{ padding: '4px 8px', color: 'var(--rose)' }}
                    onClick={() => handleDelete(inst)}
                    disabled={deleting === inst.id}
                    title="Delete connector"
                  >
                    {deleting === inst.id
                      ? <Loader2 size={13} className="animate-spin" />
                      : <Trash2 size={13} />
                    }
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Rclone quick-access banner */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Cloud size={22} color="var(--blue-500)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Rclone cloud remotes</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Google Drive, OneDrive, Dropbox, Backblaze B2, WebDAV, S3 and more.
            </div>
          </div>
          <button className="btn btn-primary" style={{ flexShrink: 0 }} onClick={() => setShowRclone(true)}>
            <Cloud size={14} /> Manage remotes
          </button>
        </div>
        <ConnectorHelp
          help={RCLONE_OVERVIEW_HELP}
          compact
          title="New to rclone? What it is & whether you need to install anything"
        />
      </div>

      {/* Available connector types */}
      {definitions.length > 0 && (
        <section>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
            Add a connector
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {definitions.map(conn => (
              <div key={conn.type} className="card" style={{
                background: 'var(--surface-1)', padding: '14px 16px',
                display: 'flex', flexDirection: 'column', gap: 8,
                cursor: 'pointer', border: '1px solid var(--surface-4)',
              }} onClick={() => setShowWizard(conn.type)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {TYPE_ICON[conn.type] || <Server size={18} />}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{conn.displayName}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{conn.description}</div>
                  </div>
                  <Plus size={16} color="var(--blue-400, #60a5fa)" />
                </div>
                {/* Show how many instances already exist */}
                {instances.filter(i => i.type === conn.type).length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {instances.filter(i => i.type === conn.type).length} configured
                  </div>
                )}
                {/* Collapsed "what is this" help. stopPropagation so toggling
                    it doesn't also open the add-connector wizard. */}
                <div onClick={e => e.stopPropagation()}>
                  <ConnectorHelp integrationKey={conn.type} compact />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
