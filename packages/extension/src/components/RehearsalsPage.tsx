import React, { useEffect, useState, useCallback } from 'react'
import {
  listRehearsals, getPolicies, getRehearsalReport, abortRehearsal, deleteRehearsal,
} from '../api'
import { RehearsalWizard } from './RehearsalWizard'
import {
  ShieldCheck, ShieldX, Clock, CheckCircle2, XCircle, Loader2,
  Play, Trash2, ChevronDown, ChevronRight, AlertCircle, X,
} from 'lucide-react'

interface Props {
  onNavigate?: (tab: string) => void
}

export const RehearsalsPage: React.FC<Props> = ({ onNavigate }) => {
  const [runs, setRuns] = useState<any[]>([])
  const [policies, setPolicies] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<any>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [aborting, setAborting] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, p] = await Promise.all([
        listRehearsals().catch(() => []),
        getPolicies().catch(() => []),
      ])
      setRuns(r as any[])
      setPolicies(p as any[])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const toggleExpand = async (id: string) => {
    if (expanded === id) {
      setExpanded(null)
      setDetail(null)
      return
    }
    setExpanded(id)
    setDetail(null)
    try {
      const report = await getRehearsalReport(id)
      setDetail(report)
    } catch { /* ignore */ }
  }

  const handleAbort = async (id: string) => {
    setAborting(id)
    try {
      await abortRehearsal(id)
      await load()
    } catch { /* ignore */ }
    setAborting(null)
  }

  const handleDelete = async (id: string) => {
    setDeleting(id)
    try {
      await deleteRehearsal(id)
      if (expanded === id) { setExpanded(null); setDetail(null) }
      await load()
    } catch { /* ignore */ }
    setDeleting(null)
  }

  const statusIcon = (status: string, ok: boolean) => {
    switch (status) {
      case 'success': return <CheckCircle2 size={14} color="var(--emerald)" />
      case 'failed': return <XCircle size={14} color="var(--rose)" />
      case 'aborted': return <AlertCircle size={14} color="var(--amber)" />
      default: return <Loader2 size={14} className="animate-spin" color="var(--blue-400, #60a5fa)" />
    }
  }

  const statusBadge = (status: string, ok: boolean) => {
    const cls = status === 'success' ? 'badge-success'
      : status === 'failed' ? 'badge-danger'
      : status === 'aborted' ? 'badge-warning'
      : 'badge-info'
    return <span className={`badge ${cls}`}>{status}</span>
  }

  const policyName = (policyId?: string) => {
    if (!policyId) return '—'
    const p = policies.find(x => x.id === policyId)
    return p?.name || policyId.slice(0, 8)
  }

  const fmtDuration = (ms?: number) => {
    if (!ms) return '—'
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    return `${(ms / 60_000).toFixed(1)}m`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Restore Rehearsals</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Verify your backups by restoring them into a sandboxed network and running smoke checks.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>
          <Play size={14} /> New rehearsal
        </button>
      </div>

      {/* Wizard modal */}
      {wizardOpen && (
        <RehearsalWizard
          onClose={() => setWizardOpen(false)}
          onSuccess={() => { setWizardOpen(false); load() }}
        />
      )}

      {/* Runs list */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13, padding: '24px 0' }}>
          <Loader2 size={14} className="animate-spin" /> Loading rehearsals…
        </div>
      ) : runs.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 16px' }}>
          <ShieldCheck size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            No rehearsals yet. Run one to verify your backups are actually restorable.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {runs.map(run => (
            <div key={run.id} className="card" style={{ background: 'var(--surface-1)', overflow: 'hidden' }}>
              {/* Row */}
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  cursor: 'pointer',
                }}
                onClick={() => toggleExpand(run.id)}
              >
                {expanded === run.id
                  ? <ChevronDown size={14} color="var(--text-muted)" />
                  : <ChevronRight size={14} color="var(--text-muted)" />
                }
                {statusIcon(run.status, run.ok)}
                <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'monospace' }}>
                  {run.id.slice(0, 8)}
                </span>
                {statusBadge(run.status, run.ok)}
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {policyName(run.policyId)}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={11} /> {fmtDuration(run.durationMs)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(run.startedAt).toLocaleString()}
                </span>
              </div>

              {/* Expanded detail */}
              {expanded === run.id && (
                <div style={{
                  borderTop: '1px solid var(--surface-4)', padding: '12px',
                  display: 'flex', flexDirection: 'column', gap: 10,
                }}>
                  {!detail ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
                      <Loader2 size={12} className="animate-spin" /> Loading report…
                    </div>
                  ) : (
                    <>
                      {/* Steps */}
                      {detail.steps?.length > 0 && (
                        <div>
                          <label className="form-label" style={{ marginBottom: 4 }}>Steps</label>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {detail.steps.map((step: any, i: number) => (
                              <div key={i} style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                fontSize: 12, padding: '3px 0',
                              }}>
                                {step.ok
                                  ? <CheckCircle2 size={11} color="var(--emerald)" />
                                  : <XCircle size={11} color="var(--rose)" />
                                }
                                <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{step.label}</span>
                                {step.detail && (
                                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>— {step.detail}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Smoke check results */}
                      {detail.smokeCheckResults?.length > 0 && (
                        <div>
                          <label className="form-label" style={{ marginBottom: 4 }}>Smoke checks</label>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {detail.smokeCheckResults.map((r: any, i: number) => (
                              <div key={i} className="card" style={{
                                background: r.ok ? 'var(--emerald-dim, rgba(16,185,129,0.06))' : 'var(--rose-dim, rgba(244,63,94,0.06))',
                                padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8,
                              }}>
                                {r.ok
                                  ? <CheckCircle2 size={13} color="var(--emerald)" />
                                  : <XCircle size={13} color="var(--rose)" />
                                }
                                <span style={{ fontSize: 12, fontWeight: 600 }}>
                                  {r.check.kind}:{r.check.container}
                                </span>
                                {r.check.kind === 'http' && (
                                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    :{r.check.port}{r.check.path || '/'}
                                  </span>
                                )}
                                {r.check.kind === 'sql_select_1' && (
                                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    {r.check.driver}/{r.check.db}
                                  </span>
                                )}
                                {r.detail && (
                                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                                    {r.detail}
                                  </span>
                                )}
                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                  {fmtDuration(r.durationMs)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Resources */}
                      {(detail.resources?.containers?.length > 0 || detail.resources?.volumes?.length > 0) && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          Resources: {detail.resources.containers?.length || 0} containers, {detail.resources.volumes?.length || 0} volumes
                          {detail.resources.network && <span> · {detail.resources.network}</span>}
                        </div>
                      )}
                    </>
                  )}

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {(run.status === 'pending' || run.status === 'preparing' || run.status === 'restoring' || run.status === 'launching' || run.status === 'probing') && (
                      <button
                        className="btn btn-ghost"
                        onClick={(e) => { e.stopPropagation(); handleAbort(run.id) }}
                        disabled={aborting === run.id}
                      >
                        {aborting === run.id
                          ? <><Loader2 size={13} className="animate-spin" /> Aborting…</>
                          : <><X size={13} /> Abort</>
                        }
                      </button>
                    )}
                    <button
                      className="btn btn-ghost"
                      onClick={(e) => { e.stopPropagation(); handleDelete(run.id) }}
                      disabled={deleting === run.id}
                      style={{ color: 'var(--rose)' }}
                    >
                      {deleting === run.id
                        ? <><Loader2 size={13} className="animate-spin" /> Deleting…</>
                        : <><Trash2 size={13} /> Delete</>
                      }
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}