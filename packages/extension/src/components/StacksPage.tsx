import React, { useEffect, useState, useCallback } from 'react'
import { listStacks, protectStack, listAllBackups, getPolicies } from '../api'
import { humanizeCron } from '../utils/cronHumanize'
import {
  Layers, ShieldPlus, RefreshCw, Loader2, CheckCircle2, AlertCircle,
  Clock, Shield, Edit2, Calendar,
} from 'lucide-react'
import { Backup, BackupPolicy } from '@docker-rescue-kit/shared'
import { EmptyState } from './EmptyState'

interface Stack {
  project: string
  containers: any[]
  volumes: string[]
  networks: string[]
}

interface Props {
  onEditPolicy?: (policy: BackupPolicy) => void
}

export const StacksPage: React.FC<Props> = ({ onEditPolicy }) => {
  const [stacks, setStacks]       = useState<Stack[]>([])
  const [backups, setBackups]     = useState<Backup[]>([])
  const [policies, setPolicies]   = useState<BackupPolicy[]>([])
  const [loading, setLoading]     = useState(true)
  const [protectingId, setProtectingId] = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, b, p] = await Promise.all([
        listStacks(),
        listAllBackups().catch(() => [] as Backup[]),
        getPolicies().catch(() => [] as BackupPolicy[]),
      ])
      setStacks(s)
      setBackups(b)
      setPolicies(p)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const protect = async (project: string) => {
    setProtectingId(project)
    setError(null)
    try {
      await protectStack(project)
      // Reload to pick up the newly created (or confirmed existing) policy
      await load()
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message)
    } finally {
      setProtectingId(null)
    }
  }

  const policyForStack = (project: string): BackupPolicy | undefined =>
    policies.find(p => p.name === `stack-${project}`)

  const stackLastBackupStatus = (s: Stack): 'success' | 'failed' | 'never' => {
    const names = new Set([
      ...s.containers.map((c: any) => (c.Names?.[0] || c.Id).replace(/^\//, '')),
      ...s.volumes,
    ])
    const related = backups
      .filter(b => b.targets.some(t => names.has(t.selector)))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    if (related.length === 0) return 'never'
    return related[0].status === 'success' ? 'success' : 'failed'
  }

  const statusInfo = {
    success: { icon: <CheckCircle2 size={13} color="var(--emerald)" />, label: 'Last backup OK',    cls: 'badge-success' as const },
    failed:  { icon: <AlertCircle  size={13} color="var(--rose)" />,    label: 'Last backup failed', cls: 'badge-danger'  as const },
    never:   { icon: <Clock        size={13} color="var(--text-muted)" />, label: 'No backups yet', cls: 'badge-muted'   as const },
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Compose Stacks</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Detected via <span style={{ fontFamily: 'monospace', fontSize: 11 }}>com.docker.compose.project</span> labels.
            One-click protect creates a daily backup policy for all containers&nbsp;+&nbsp;volumes.
          </p>
        </div>
        <button className="btn btn-ghost" onClick={load} disabled={loading} style={{ flexShrink: 0 }}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div style={{
          background: 'var(--rose-dim)', border: '1px solid rgba(244,63,94,0.3)',
          borderRadius: 'var(--r-md)', padding: '10px 14px', fontSize: 13, color: '#fda4af',
        }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, gap: 8, color: 'var(--text-muted)' }}>
          <Loader2 size={16} className="animate-spin" /> Scanning Docker…
        </div>
      ) : stacks.length === 0 ? (
        <EmptyState
          icon={<Layers size={28} />}
          title="No Compose Stacks Detected"
          description="Start a docker-compose project to see it here. Stacks are detected via the com.docker.compose.project label on running containers."
          action={{ label: 'Refresh', onClick: load }}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(288px, 1fr))', gap: 12 }}>
          {stacks.map(s => {
            const st        = stackLastBackupStatus(s)
            const si        = statusInfo[st]
            const policy    = policyForStack(s.project)
            const protected_ = !!policy
            const protecting = protectingId === s.project

            return (
              <div key={s.project} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                {/* Card header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                    background: protected_ ? 'var(--emerald-dim)' : 'var(--indigo-dim)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {protected_
                      ? <Shield size={18} color="var(--emerald)" />
                      : <Layers size={18} color="var(--indigo)" />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.project}
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      {protected_ && (
                        <span className="badge badge-success" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <Shield size={11} /> Protected
                        </span>
                      )}
                      <span className={`badge ${si.cls}`} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        {si.icon} {si.label}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Stats row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
                  {[
                    ['Containers', s.containers.length],
                    ['Volumes',    s.volumes.length],
                    ['Networks',   s.networks.length],
                  ].map(([label, val]) => (
                    <div key={label as string} style={{
                      background: 'var(--surface-1)', borderRadius: 'var(--r-sm)',
                      padding: '6px 8px', textAlign: 'center',
                    }}>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>{val}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                    </div>
                  ))}
                </div>

                {/* Volume chip preview */}
                {s.volumes.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {s.volumes.slice(0, 4).map(v => (
                      <span key={v} className="target-chip" style={{ fontSize: 11 }}>{v}</span>
                    ))}
                    {s.volumes.length > 4 && (
                      <span className="badge badge-muted">+{s.volumes.length - 4}</span>
                    )}
                  </div>
                )}

                {/* Policy schedule info */}
                {policy && (() => {
                  const human = humanizeCron(policy.schedule)
                  const isRaw = human === policy.schedule
                  return (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      background: 'var(--surface-1)', borderRadius: 'var(--r-sm)',
                      padding: '6px 10px', fontSize: 12, color: 'var(--text-muted)',
                    }}>
                      <Calendar size={12} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>
                        Schedule:{' '}
                        {isRaw
                          ? <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 11 }}>{policy.schedule}</span>
                          : <span style={{ color: 'var(--text-primary)' }} title={policy.schedule}>{human}</span>
                        }
                      </span>
                    </div>
                  )
                })()}

                {/* Action buttons */}
                {protected_ ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {onEditPolicy && (
                      <button
                        className="btn btn-ghost"
                        style={{ flex: 1, justifyContent: 'center' }}
                        onClick={() => onEditPolicy(policy!)}
                      >
                        <Edit2 size={13} /> Edit schedule
                      </button>
                    )}
                    <button
                      className="btn btn-ghost"
                      style={{ flex: 1, justifyContent: 'center', color: 'var(--emerald)' }}
                      disabled
                    >
                      <Shield size={13} /> Protected
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={() => protect(s.project)}
                    disabled={protecting}
                    title="Creates a daily backup policy for all containers and volumes in this stack"
                  >
                    {protecting ? (
                      <><Loader2 size={14} className="animate-spin" /> Creating policy…</>
                    ) : (
                      <><ShieldPlus size={14} /> Protect this stack</>
                    )}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
