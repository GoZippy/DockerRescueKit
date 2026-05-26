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
    <div className="space-y-6 animate-fade-in">
      {showWizard && (
        <AddConnectorWizard
          onClose={() => { setShowWizard(false); load() }}
        />
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-card p-6 flex flex-col gap-2">
          <div className="flex justify-between items-center text-slate-400">
            <span className="font-bold">Stored Credentials</span>
            <KeyRound size={20} className="text-blue-400" />
          </div>
          <span className="text-3xl font-bold">{loading ? '—' : instances.length}</span>
          <span className="text-xs text-slate-500">connector instances saved</span>
        </div>
        <div className="glass-card p-6 flex flex-col gap-2">
          <div className="flex justify-between items-center text-slate-400">
            <span className="font-bold">Encryption</span>
            <Lock size={20} className="text-emerald-400" />
          </div>
          <span className="text-3xl font-bold text-emerald-400">AES-256-GCM</span>
          <span className="text-xs text-slate-500">{totalEncryptedFields} encrypted field{totalEncryptedFields === 1 ? '' : 's'} at rest</span>
        </div>
        <div className="glass-card p-6 flex flex-col gap-2 border-emerald-500/20">
          <div className="flex justify-between items-center text-slate-400">
            <span className="font-bold">Unused Credentials</span>
            <ShieldAlert size={20} className={orphanedCount > 0 ? 'text-amber-400' : 'text-emerald-400'} />
          </div>
          <span className={`text-3xl font-bold ${orphanedCount > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
            {loading ? '—' : orphanedCount}
          </span>
          <span className="text-xs text-slate-500">not referenced by any policy</span>
        </div>
      </div>

      {/* List */}
      <div className="glass-card p-6">
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <KeyRound className="text-indigo-400" size={20} />
            Encrypted Credentials
          </h2>
          <button
            className="glow-btn py-2 px-4 text-sm flex items-center gap-2"
            onClick={() => setShowWizard(true)}
          >
            <Plus size={14} /> Add Credential
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-6">
          Saved credential sets for cloud and network storage backends. Sensitive fields are encrypted at rest with AES-256-GCM and never decrypted on disk.
        </p>

        {loading ? (
          <div className="flex justify-center items-center py-8 text-slate-500">
            <Loader2 className="animate-spin mr-2" /> Scanning vault…
          </div>
        ) : instances.length === 0 ? (
          <div className="text-center py-12 border-2 border-dashed border-slate-800 rounded-2xl bg-slate-900/30">
            <KeyRound size={28} className="mx-auto text-slate-600 mb-3" />
            <p className="text-slate-400 mb-1">No encrypted credentials yet.</p>
            <p className="text-sm text-slate-500 mb-4">
              Add a connector to vault credentials for S3, SFTP, SMB, Proxmox, TrueNAS, or Rclone.
            </p>
            <button className="glow-btn py-2 px-4 text-sm inline-flex items-center gap-2" onClick={() => setShowWizard(true)}>
              <Plus size={14} /> Add your first credential
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {instances.map(inst => {
              const refs = policiesReferencing(inst.id, policies)
              const secretCount = countSensitive(inst.config)
              return (
                <div
                  key={inst.id}
                  className="p-4 rounded-xl bg-white/5 border border-white/10 flex flex-col gap-3 group hover:border-blue-500/40 transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-3 bg-slate-800 rounded-lg text-indigo-300 group-hover:text-blue-300 transition-colors shrink-0">
                        {typeIcon(inst.type)}
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-bold text-slate-200 truncate" title={inst.name}>{inst.name}</h3>
                        <p className="text-xs text-slate-500 font-mono uppercase tracking-wider">{inst.type}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(inst)}
                      className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors shrink-0"
                      title="Delete credential"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  <div className="text-sm text-slate-400 font-mono truncate" title={summarizeTarget(inst)}>
                    {summarizeTarget(inst)}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded border"
                      style={{
                        color: statusColor(inst.status),
                        borderColor: `${statusColor(inst.status)}33`,
                        background: `${statusColor(inst.status)}10`,
                      }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: statusColor(inst.status) }}
                      />
                      {inst.status}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
                      <Lock size={11} />
                      {secretCount} encrypted field{secretCount === 1 ? '' : 's'}
                    </span>
                    {refs.length === 0 ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-amber-500/20 bg-amber-500/10 text-amber-400">
                        Unused
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-slate-700 bg-slate-800/50 text-slate-300"
                        title={refs.map(p => p.name).join(', ')}
                      >
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
          <div className="mt-4 flex justify-end">
            <button
              onClick={load}
              className="text-xs text-slate-500 hover:text-slate-300 inline-flex items-center gap-1"
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
