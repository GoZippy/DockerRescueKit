import React, { useEffect, useState } from 'react'
import axios from 'axios'
import { listVerifyHistory } from '../api'
import { ShieldCheck, ShieldAlert, RefreshCw, Clock, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { PageError, PageErrorKind } from './PageError'

interface VerifyRecord {
  id: string
  backupId: string
  policyId: string
  ok: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  steps: Array<{ label: string; ok: boolean; detail?: string }>
}

export const VerifyHistory: React.FC = () => {
  const [records, setRecords] = useState<VerifyRecord[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorKind, setErrorKind] = useState<PageErrorKind | null>(null)

  const load = async () => {
    setLoading(true)
    setErrorKind(null)
    try {
      setRecords(await listVerifyHistory())
    } catch (e) {
      console.error('Failed to load verify history', e)
      if (axios.isAxiosError(e)) {
        if (e.response?.status === 401) setErrorKind('auth')
        else if (e.response?.status === 503) setErrorKind('docker-offline')
        else setErrorKind('unknown')
      } else {
        setErrorKind('unknown')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (errorKind) {
    return (
      <PageError
        kind={errorKind}
        title={errorKind === 'unknown' ? 'Failed to load verification history' : undefined}
        onRetry={load}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Verification History</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Scratch-restore results for verified backups
          </p>
        </div>
        <button className="btn btn-ghost" onClick={load}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, gap: 8, color: 'var(--text-muted)' }}>
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : records.length === 0 ? (
        <div className="empty-state card">
          <ShieldCheck size={32} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <div style={{ fontWeight: 700, marginBottom: 4 }}>No verifications yet</div>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            Verifications do a real scratch-restore to confirm your backups are usable.
            You can start one manually: go to <strong>Backup History</strong> and click the
            shield icon on any successful backup. To run verifications automatically on a
            schedule, open a policy, click <strong>Edit policy</strong>, and set a
            verify schedule in the Schedule step.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {records.map((r, idx) => {
            const isExp = expanded === r.id
            const passCount = r.steps.filter(s => s.ok).length
            return (
              <div
                key={r.id}
                style={{ borderBottom: idx < records.length - 1 ? '1px solid var(--surface-4)' : undefined }}
              >
                <button
                  onClick={() => setExpanded(isExp ? null : r.id)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer',
                    textAlign: 'left', color: 'inherit',
                    transition: 'background-color 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--surface-3)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  {r.ok
                    ? <ShieldCheck size={18} color="var(--emerald)" style={{ flexShrink: 0 }} />
                    : <ShieldAlert  size={18} color="var(--rose)"    style={{ flexShrink: 0 }} />}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {r.ok ? 'Pass' : 'FAIL'} — backup{' '}
                      <span className="font-mono" style={{ fontSize: 12 }}>{r.backupId.slice(0, 8)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, fontSize: 12, color: 'var(--text-muted)' }}>
                      <Clock size={11} />
                      <span>{new Date(r.startedAt).toLocaleString()}</span>
                      <span>·</span>
                      <span>{(r.durationMs / 1000).toFixed(1)}s</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <span className={`badge ${r.ok ? 'badge-success' : 'badge-danger'}`}>
                      {passCount}/{r.steps.length} steps
                    </span>
                    {isExp ? <ChevronDown size={14} color="var(--text-muted)" /> : <ChevronRight size={14} color="var(--text-muted)" />}
                  </div>
                </button>

                {isExp && (
                  <div style={{
                    padding: '8px 16px 14px 46px',
                    background: 'var(--surface-1)',
                    borderTop: '1px solid var(--surface-4)',
                  }}>
                    {r.steps.map((s, i) => (
                      <div
                        key={i}
                        className="font-mono"
                        style={{ fontSize: 12, color: s.ok ? '#34d399' : '#fb7185', lineHeight: 1.7 }}
                      >
                        [{s.ok ? 'ok' : 'fail'}] {s.label}{s.detail ? ` — ${s.detail}` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
