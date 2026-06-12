import React, { useEffect, useState } from 'react'
import axios from 'axios'
import {
  Database, Cloud, Server, HardDrive, Plug,
  Lock, ShieldAlert, KeyRound, Plus, X, Loader2, RefreshCw,
} from 'lucide-react'
import { BackupPolicy, ConnectorInstance } from '@docker-rescue-kit/shared'
import { getConnectorInstances, getPolicies, deleteConnectorInstance } from '../api'
import { AddConnectorWizard } from './AddConnectorWizard'
import { PageError, PageErrorKind } from './PageError'
import { useToast } from '../hooks/useToast'

const SENSITIVE_PARTS = ['password', 'secret', 'key', 'token', 'accesskey', 'secretkey', 'credential']
const isSensitiveKey = (k: string) => {
  const lower = k.toLowerCase()
  return SENSITIVE_PARTS.some(p => lower.includes(p))
}

const countSensitive = (cfg: Record<string, any> | undefined): number => {
  if (!cfg) return 0
  let n = 0
  for (const [k, v] of Object.entries(cfg)) {
    if (v == null || v === '') continue
    if (isSensitiveKey(k)) n++
  }
  return n
}

const summarizeTarget = (inst: ConnectorInstance): string => {
  const c = inst.config || {}
  switch (inst.type) {
    case 's3':       return [c.bucket, c.endpoint || c.region].filter(Boolean).join(' @ ') || '—'
    case 'smb':      return [c.host, c.share].filter(Boolean).join('/') || '—'
    case 'nfs':      return [c.host, c.path].filter(Boolean).join(':') || '—'
    case 'sftp':     return c.port ? `${c.host}:${c.port}` : (c.host || '—')
    case 'rclone':   return c.remote || c.remoteName || '—'
    case 'proxmox':  return c.host || '—'
    case 'truenas':  return c.host || '—'
    default:         return c.host || c.endpoint || c.path || '—'
  }
}

const typeIcon = (type: string, size = 18) => {
  switch (type) {
    case 's3':      return <Database size={size} />
    case 'rclone':  return <Cloud size={size} />
    case 'smb':
    case 'nfs':
    case 'sftp':    return <Server size={size} />
    case 'proxmox':
    case 'truenas': return <HardDrive size={size} />
    default:        return <Plug size={size} />
  }
}

const statusColor = (s: string) => {
  switch (s) {
    case 'online':  return 'var(--green-500, #10b981)'
    case 'offline':
    case 'error':   return 'var(--red-500, #ef4444)'
    default:        return 'var(--text-muted, #64748b)'
  }
}

const errorKindFromAxios = (e: unknown): PageErrorKind => {
  if (axios.isAxiosError(e)) {
    if (e.response?.status === 401) return 'auth'
    if (e.response?.status === 503) return 'docker-offline'
  }
  return 'unknown'
}

export const VaultList: React.FC = () => {
  const [instances, setInstances] = useState<ConnectorInstance[]>([])
  const [policies, setPolicies] = useState<BackupPolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [errorKind, setErrorKind] = useState<PageErrorKind | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const toast = useToast()

  const load = async () => {
    setErrorKind(null)
    try {
      const [insts, pols] = await Promise.all([
        getConnectorInstances(),
        getPolicies().catch(() => [] as BackupPolicy[]),
      ])
      setInstances(insts)
      setPolicies(pols)
    } catch (e) {
      console.error('Failed to load vault', e)
      setErrorKind(errorKindFromAxios(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleDelete = async (inst: ConnectorInstance) => {
    const refs = policiesReferencing(inst.id, policies)
    const warn = refs.length
      ? `${refs.length} policy${refs.length === 1 ? '' : ' policies'} reference this credential and will lose access. Continue?`
      : 'Delete this credential? This cannot be undone.'
    if (!confirm(warn)) return
    try {
      await deleteConnectorInstance(inst.id)
      toast.push('success', 'Credential deleted')
      load()
    } catch (e) {
      const msg = axios.isAxiosError(e) ? (e.response?.data as any)?.error || e.message : 'Delete failed'
      toast.push('error', `Failed to delete: ${msg}`)
    }
  }

  if (errorKind) {
    return (
      <PageError
        kind={errorKind}
        title={errorKind === 'unknown' ? 'Failed to load vault' : undefined}
        onRetry={() => { setLoading(true); load() }}
      />
    )
  }

  const totalEncryptedFields = instances.reduce((sum, i) => sum + countSensitive(i.config), 0)
  const orphanedCount = instances.filter(i => policiesReferencing(i.id, policies).length === 0).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} className="animate-fade-in">
      {showWizard && (
        <AddConnectorWizard
          onClose={() => { setShowWizard(false); load() }}
        />
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-secondary)' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Stored Credentials</span>
            <KeyRound size={18} color="var(--blue-500)" />
          </div>
          <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{loading ? '—' : instances.length}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>connector instances saved</span>
        </div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-secondary)' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Encryption</span>
            <Lock size={18} color="var(--emerald)" />
          </div>
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--emerald)' }}>AES-256-GCM</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{totalEncryptedFields} encrypted field{totalEncryptedFields === 1 ? '' : 's'} at rest</span>
        </div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-secondary)' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Unused Credentials</span>
            <ShieldAlert size={18} color={orphanedCount > 0 ? 'var(--amber)' : 'var(--emerald)'} />
          </div>
          <span style={{ fontSize: 28, fontWeight: 700, color: orphanedCount > 0 ? 'var(--amber)' : 'var(--emerald)' }}>
            {loading ? '—' : orphanedCount}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>not referenced by any policy</span>
        </div>
      </div>

      {/* List */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--surface-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 15 }}>
            <KeyRound size={18} color="var(--indigo)" />
            Encrypted Credentials
          </div>
          <button
            className="btn btn-primary"
            onClick={() => setShowWizard(true)}
          >
            <Plus size={14} /> Add Credential
          </button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '10px 16px 0' }}>
          Saved credential sets for cloud and network storage. Sensitive fields are encrypted at rest with AES-256-GCM.
        </p>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '40px 0', gap: 8, color: 'var(--text-muted)' }}>
            <Loader2 size={16} className="animate-spin" /> Scanning vault…
          </div>
        ) : instances.length === 0 ? (
          <div style={{
            margin: 16, padding: 32,
            border: '2px dashed var(--surface-4)',
            borderRadius: 'var(--r-lg)',
            textAlign: 'center',
          }}>
            <KeyRound size={28} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
            <p style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>No encrypted credentials yet.</p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
              Add a connector to save credentials for S3, SFTP, SMB, Proxmox, TrueNAS, or Rclone.
            </p>
            <button className="btn btn-primary" onClick={() => setShowWizard(true)}>
              <Plus size={14} /> Add your first credential
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, padding: 16 }}>
            {instances.map(inst => {
              const refs = policiesReferencing(inst.id, policies)
              const secretCount = countSensitive(inst.config)
              return (
                <div
                  key={inst.id}
                  className="card card-hover"
                  style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <div style={{
                        padding: 10, background: 'var(--surface-3)',
                        borderRadius: 'var(--r-md)', color: 'var(--indigo)', flexShrink: 0,
                      }}>
                        {typeIcon(inst.type)}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }} title={inst.name}>
                          {inst.name}
                        </div>
                        <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          {inst.type}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(inst)}
                      className="btn-icon"
                      style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                      title="Delete credential"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  <div className="font-mono" style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={summarizeTarget(inst)}>
                    {summarizeTarget(inst)}
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <span
                      className="badge"
                      style={{
                        color: statusColor(inst.status),
                        borderColor: `${statusColor(inst.status)}44`,
                        background: `${statusColor(inst.status)}18`,
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor(inst.status), display: 'inline-block' }} />
                      {inst.status}
                    </span>
                    <span className="badge badge-success">
                      <Lock size={10} />
                      {secretCount} encrypted field{secretCount === 1 ? '' : 's'}
                    </span>
                    {refs.length === 0 ? (
                      <span className="badge badge-warning">Unused</span>
                    ) : (
                      <span className="badge badge-muted" title={refs.map(p => p.name).join(', ')}>
                        Used by {refs.length} polic{refs.length === 1 ? 'y' : 'ies'}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {!loading && instances.length > 0 && (
          <div style={{ padding: '8px 16px 14px', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={load}
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const policiesReferencing = (instanceId: string, policies: BackupPolicy[]): BackupPolicy[] => {
  return policies.filter(p => {
    const s: any = p.storage
    return s?.connectorId === instanceId || s?.id === instanceId
  })
}
