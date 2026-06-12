import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import {
  Plus, Clock, PlayCircle, MoreVertical,
  Loader2, CheckCircle2, AlertCircle, RefreshCw,
} from 'lucide-react'
import { getPolicies, runPolicy, deletePolicy } from '../api'
import { BackupPolicy } from '@docker-rescue-kit/shared'
import { PolicyWizard } from './PolicyWizard'
import { PolicyDetail } from './PolicyDetail'
import { PageError, PageErrorKind } from './PageError'
import { useToast } from '../hooks/useToast'
import { humanizeCron } from '../utils/cronHumanize'

interface PolicyListProps {
  initialPolicyId?: string
}

export const PolicyList: React.FC<PolicyListProps> = ({ initialPolicyId }) => {
  const [policies, setPolicies] = useState<BackupPolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [errorKind, setErrorKind] = useState<PageErrorKind | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [showWizard, setShowWizard] = useState(false)
  const [selected, setSelected] = useState<BackupPolicy | null>(null)
  const [editPolicy, setEditPolicy] = useState<BackupPolicy | null>(null)
  const [kebabOpenId, setKebabOpenId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()

  const load = async () => {
    setErrorKind(null)
    try {
      const data = await getPolicies()
      setPolicies(data)
      if (initialPolicyId && !selected) {
        const pre = data.find(p => p.id === initialPolicyId)
        if (pre) setSelected(pre)
      }
    } catch (e) {
      console.error('Failed to load policies', e)
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

  const handleRun = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setRunningIds(prev => new Set(prev).add(id))
    try {
      await runPolicy(id)
      toast.push('success', 'Backup started successfully')
      await load()
    } catch (err: any) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error || err.message)
        : (err?.message || 'Unknown error')
      toast.push('error', `Backup failed: ${msg}`)
    } finally {
      setRunningIds(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  const onWizardSuccess = () => {
    setShowWizard(false)
    setEditPolicy(null)
    setLoading(true)
    load()
  }

  const handleDelete = async (id: string) => {
    setDeleting(true)
    try {
      await deletePolicy(id)
      toast.push('success', 'Policy deleted')
      setConfirmDeleteId(null)
      await load()
    } catch (err: any) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error || err.message) : (err?.message || 'Unknown error')
      toast.push('error', `Delete failed: ${msg}`)
    } finally {
      setDeleting(false)
    }
  }

  // Close kebab dropdown on Escape
  useEffect(() => {
    if (!kebabOpenId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setKebabOpenId(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [kebabOpenId])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, gap: 8, color: 'var(--text-muted)' }}>
        <Loader2 size={16} className="animate-spin" /> Loading policies…
      </div>
    )
  }

  if (errorKind) {
    return (
      <PageError
        kind={errorKind}
        title={errorKind === 'unknown' ? 'Failed to load policies' : undefined}
        onRetry={() => { setLoading(true); load() }}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Backup Policies</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            {policies.length} {policies.length === 1 ? 'policy' : 'policies'} · {policies.filter(p => p.enabled).length} active
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => { setLoading(true); load() }}>
            <RefreshCw size={14} />
          </button>
          <button className="btn btn-primary" onClick={() => setShowWizard(true)}>
            <Plus size={14} /> New Policy
          </button>
        </div>
      </div>

      {/* Policy grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
        {policies.map(policy => (
          <PolicyCard
            key={policy.id}
            policy={policy}
            running={runningIds.has(policy.id)}
            onRun={e => handleRun(e, policy.id)}
            onClick={() => setSelected(policy)}
            kebabOpen={kebabOpenId === policy.id}
            onKebabToggle={e => { e.stopPropagation(); setKebabOpenId(prev => prev === policy.id ? null : policy.id) }}
            onKebabClose={() => setKebabOpenId(null)}
            onEdit={() => { setKebabOpenId(null); setEditPolicy(policy) }}
            onDelete={() => { setKebabOpenId(null); setConfirmDeleteId(policy.id) }}
          />
        ))}

        {/* Add placeholder */}
        <button
          onClick={() => setShowWizard(true)}
          style={{
            background: 'var(--surface-2)',
            border: '2px dashed var(--surface-4)',
            borderRadius: 'var(--r-lg)',
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            minHeight: 160,
            cursor: 'pointer',
            transition: 'border-color 0.15s, background-color 0.15s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue-border)'
            ;(e.currentTarget as HTMLElement).style.backgroundColor = 'var(--blue-dim)'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--surface-4)'
            ;(e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-2)'
          }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: 'var(--surface-3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Plus size={22} color="var(--text-muted)" />
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>New Policy</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Protect containers & volumes
            </div>
          </div>
        </button>
      </div>

      {showWizard && (
        <PolicyWizard onClose={() => setShowWizard(false)} onSuccess={onWizardSuccess} />
      )}
      {editPolicy && (
        <PolicyWizard
          initialPolicy={editPolicy}
          onClose={() => setEditPolicy(null)}
          onSuccess={onWizardSuccess}
        />
      )}
      {selected && (
        <PolicyDetail
          policy={selected}
          onClose={() => setSelected(null)}
          onChange={load}
        />
      )}

      {/* Confirm delete dialog */}
      {confirmDeleteId && (() => {
        const p = policies.find(x => x.id === confirmDeleteId)
        return (
          <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)}>
            <div
              className="modal-panel"
              style={{ maxWidth: 440 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-delete-title"
              onClick={e => e.stopPropagation()}
            >
              <div className="modal-header">
                <h3 id="confirm-delete-title" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                  Delete policy?
                </h3>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                  <strong>"{p?.name}"</strong> will be removed. Existing backup files in storage are kept.
                </p>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setConfirmDeleteId(null)} disabled={deleting}>
                  Cancel
                </button>
                <button className="btn btn-danger" onClick={() => handleDelete(confirmDeleteId)} disabled={deleting}>
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : null}
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

/* ── Policy card ──────────────────────────────────────────── */
interface CardProps {
  policy: BackupPolicy
  running: boolean
  onRun: (e: React.MouseEvent) => void
  onClick: () => void
  kebabOpen: boolean
  onKebabToggle: (e: React.MouseEvent) => void
  onKebabClose: () => void
  onEdit: () => void
  onDelete: () => void
}

const PolicyCard: React.FC<CardProps> = ({
  policy, running, onRun, onClick,
  kebabOpen, onKebabToggle, onKebabClose, onEdit, onDelete,
}) => {
  const kebabRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!kebabOpen) return
    const handler = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) {
        onKebabClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [kebabOpen, onKebabClose])

  const humanLabel = humanizeCron(policy.schedule)
  const isRaw = humanLabel === policy.schedule

  return (
  <div
    className="card card-hover"
    onClick={onClick}
    style={{
      cursor: 'pointer',
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
    }}
  >
    {/* Status stripe */}
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 3,
      background: policy.enabled ? 'var(--emerald)' : 'var(--text-muted)',
    }} />

    <div style={{ padding: '16px 16px 12px', marginTop: 3 }}>
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8, flexShrink: 0,
            background: policy.enabled ? 'var(--emerald-dim)' : 'rgba(71,85,105,0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {policy.enabled
              ? <CheckCircle2 size={18} color="var(--emerald)" />
              : <AlertCircle size={18} color="var(--text-muted)" />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {policy.name}
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
              <span className={`badge ${policy.enabled ? 'badge-success' : 'badge-muted'}`}>
                {policy.enabled ? 'Active' : 'Paused'}
              </span>
              <span className="badge badge-muted">{policy.backupType}</span>
              <span className="badge badge-info">{policy.storage.type}</span>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <button
            className="btn-icon"
            onClick={onRun}
            disabled={running}
            title="Run backup now"
            style={{ color: running ? '#60a5fa' : '#34d399' }}
          >
            {running
              ? <Loader2 size={16} className="animate-spin" />
              : <PlayCircle size={16} />}
          </button>

          {/* Kebab menu */}
          <div ref={kebabRef} style={{ position: 'relative' }}>
            <button
              className="btn-icon"
              title="More options"
              aria-label="More options"
              aria-haspopup="true"
              aria-expanded={kebabOpen}
              onClick={onKebabToggle}
            >
              <MoreVertical size={16} />
            </button>
            {kebabOpen && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                background: 'var(--surface-2)',
                border: '1px solid var(--surface-4)',
                borderRadius: 'var(--r-md)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                zIndex: 100,
                minWidth: 140,
                overflow: 'hidden',
              }}>
                {[
                  { label: 'Edit', action: onEdit },
                  { label: 'Run now', action: (e: React.MouseEvent) => { onKebabClose(); onRun(e) } },
                ].map(item => (
                  <button
                    key={item.label}
                    onClick={item.action as any}
                    style={{
                      display: 'block', width: '100%', padding: '9px 14px',
                      background: 'none', border: 'none', cursor: 'pointer',
                      textAlign: 'left', fontSize: 13, color: 'var(--text-primary)',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  >
                    {item.label}
                  </button>
                ))}
                <div style={{ height: 1, background: 'var(--surface-4)' }} />
                <button
                  onClick={onDelete}
                  style={{
                    display: 'block', width: '100%', padding: '9px 14px',
                    background: 'none', border: 'none', cursor: 'pointer',
                    textAlign: 'left', fontSize: 13, color: 'var(--rose)',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Targets row */}
      {policy.targets.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
          {policy.targets.slice(0, 3).map(t => (
            <span key={t.selector} className="target-chip" style={{ fontSize: 11 }}>
              {t.type}:{t.selector}
            </span>
          ))}
          {policy.targets.length > 3 && (
            <span className="badge badge-muted">+{policy.targets.length - 3}</span>
          )}
        </div>
      )}
    </div>

    {/* Footer */}
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 16px',
      borderTop: '1px solid var(--surface-4)',
      background: 'var(--surface-1)',
      borderRadius: '0 0 var(--r-lg) var(--r-lg)',
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12, minWidth: 0 }}
        title={isRaw ? undefined : policy.schedule}
      >
        <Clock size={12} style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isRaw
            ? <span className="font-mono" style={{ fontSize: 11 }}>{policy.schedule}</span>
            : humanLabel}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
        Keep {policy.retention.count}
      </div>
    </div>
  </div>
  )
}
