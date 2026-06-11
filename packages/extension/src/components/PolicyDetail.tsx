import React, { useEffect, useState } from 'react'
import axios from 'axios'
import { BackupPolicy, Backup, DatabaseExporter } from '@docker-rescue-kit/shared'
import { getPolicyHistory, runPolicy, verifyPolicy, deletePolicy } from '../api'
import { humanizeCron } from '../utils/cronHumanize'
import {
  Play, ShieldCheck, CheckCircle2, AlertCircle, Clock, X,
  Pencil, Trash2, Loader2, HardDrive, Layers, Database, Calendar,
} from 'lucide-react'
import { PolicyWizard } from './PolicyWizard'
import { useToast } from '../hooks/useToast'

interface Props {
  policy: BackupPolicy
  onClose: () => void
  onChange: () => void
}

export const PolicyDetail: React.FC<Props> = ({ policy, onClose, onChange }) => {
  const [history, setHistory] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [running, setRunning] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()

  const load = async () => {
    setLoading(true)
    try {
      setHistory(await getPolicyHistory(policy.id))
    } catch (e) {
      console.error('Failed to load policy history', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [policy.id])

  // Lock body scroll while modal is open
  useEffect(() => {
    document.body.classList.add('modal-open')
    return () => document.body.classList.remove('modal-open')
  }, [])

  // ESC-to-close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, editing])

  const runNow = async () => {
    setRunning(true)
    try {
      await runPolicy(policy.id)
      toast.push('success', 'Backup started')
      await load()
      onChange()
    } catch (err: any) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error || err.message) : (err?.message || 'Unknown error')
      toast.push('error', `Backup failed: ${msg}`)
    } finally {
      setRunning(false)
    }
  }

  const verifyNow = async () => {
    setVerifying(true)
    try {
      await verifyPolicy(policy.id)
      toast.push('success', 'Verification started')
      await load()
    } catch (err: any) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error || err.message) : (err?.message || 'Unknown error')
      toast.push('error', `Verify failed: ${msg}`)
    } finally {
      setVerifying(false)
    }
  }

  const doDelete = async () => {
    setDeleting(true)
    try {
      await deletePolicy(policy.id)
      toast.push('success', `Deleted policy "${policy.name}"`)
      onChange()
      onClose()
    } catch (err: any) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error || err.message) : (err?.message || 'Unknown error')
      toast.push('error', `Delete failed: ${msg}`)
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const onWizardSuccess = () => {
    setEditing(false)
    toast.push('success', 'Policy updated')
    onChange()
    onClose()
  }

  const lastSuccess = history.find(h => h.status === 'success')
  const lastFailure = history.find(h => h.status === 'failed')

  // Edit mode delegates entirely to the wizard
  if (editing) {
    return (
      <PolicyWizard
        initialPolicy={policy}
        onClose={() => setEditing(false)}
        onSuccess={onWizardSuccess}
      />
    )
  }

  return (
    <div className="modal-overlay">
      <div
        className="modal-panel"
        style={{ maxWidth: 760 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-detail-title"
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              background: policy.enabled ? 'var(--emerald-dim)' : 'rgba(71,85,105,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {policy.enabled
                ? <CheckCircle2 size={16} color="var(--emerald)" />
                : <AlertCircle size={16} color="var(--text-muted)" />}
            </div>
            <div style={{ minWidth: 0 }}>
              <h3
                id="policy-detail-title"
                style={{
                  margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {policy.name}
              </h3>
              <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
                <span className={`badge ${policy.enabled ? 'badge-success' : 'badge-muted'}`}>
                  {policy.enabled ? 'Active' : 'Paused'}
                </span>
                <span className="badge badge-muted">{policy.backupType}</span>
                <span className="badge badge-info">{policy.storage.type}</span>
              </div>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Stat tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <StatTile
              icon={<Database size={14} />}
              label="Targets"
              value={String(policy.targets.length)}
            />
            <StatTile
              icon={<CheckCircle2 size={14} color="var(--emerald)" />}
              label="Last success"
              value={lastSuccess ? new Date(lastSuccess.timestamp).toLocaleString() : '—'}
            />
            <StatTile
              icon={<AlertCircle size={14} color="var(--rose)" />}
              label="Last failure"
              value={lastFailure ? new Date(lastFailure.timestamp).toLocaleString() : '—'}
            />
            <StatTile
              icon={<Calendar size={14} />}
              label="Schedule"
              value={humanizeCron(policy.schedule)}
              subtitle={humanizeCron(policy.schedule) !== policy.schedule ? policy.schedule : undefined}
            />
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={runNow} disabled={running}>
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {running ? 'Running…' : 'Run now'}
            </button>
            <button className="btn btn-ghost" onClick={verifyNow} disabled={verifying}>
              {verifying ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              {verifying ? 'Verifying…' : 'Verify latest'}
            </button>
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              <Pencil size={14} /> Edit policy
            </button>
            <button
              className="btn btn-danger"
              style={{ marginLeft: 'auto' }}
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>

          {/* Delete confirmation */}
          {confirmDelete && (
            <div className="card" style={{
              background: 'var(--rose-dim)',
              borderColor: 'rgba(244,63,94,0.3)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <AlertCircle size={18} color="#fb7185" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 13 }}>
                <div style={{ fontWeight: 600, color: '#fb7185' }}>Delete "{policy.name}"?</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  The policy will be removed. Existing backup files in storage are kept.
                </div>
              </div>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={doDelete} disabled={deleting}>
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          )}

          {/* Targets list */}
          {policy.targets.length > 0 && (
            <div>
              <label className="form-label" style={{ marginBottom: 6 }}>
                <HardDrive size={11} style={{ marginRight: 4, verticalAlign: 'text-top' }} />
                Targets ({policy.targets.length})
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {policy.targets.map(t => (
                  <span
                    key={`${t.type}-${t.selector}`}
                    className="target-chip"
                    style={{ cursor: 'default' }}
                  >
                    {t.type}:{t.selector}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Database exporters */}
          {policy.hooks?.databases && policy.hooks.databases.length > 0 && (
            <div>
              <label className="form-label" style={{ marginBottom: 6 }}>
                <Database size={11} style={{ marginRight: 4, verticalAlign: 'text-top' }} />
                Database exporters ({policy.hooks.databases.length})
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {policy.hooks.databases.map((db, idx) => (
                  <div key={idx} className="card" style={{
                    background: 'var(--surface-1)', padding: '6px 10px',
                    display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
                  }}>
                    <Database size={12} color="var(--text-muted)" />
                    <span style={{ fontWeight: 600 }}>
                      {db.kind === 'postgres' && 'PostgreSQL'}
                      {db.kind === 'mysql' && 'MySQL / MariaDB'}
                      {db.kind === 'redis' && 'Redis'}
                      {db.kind === 'mongodb' && 'MongoDB'}
                      {db.kind === 'sqlite' && 'SQLite'}
                      {db.kind === 'influxdb' && `InfluxDB ${db.version === 'v2' ? 'v2' : 'v1'}`}
                      {db.kind === 'mssql' && 'MS SQL Server'}
                    </span>
                    <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{db.container}</span>
                    {db.kind === 'mssql' && db.authMode === 'sql' && (
                      <span className="badge badge-muted" style={{ fontSize: 10 }}>SQL auth</span>
                    )}
                    {db.kind === 'mssql' && db.server && db.server !== '.' && (
                      <span className="badge badge-muted" style={{ fontSize: 10, fontFamily: 'monospace' }}>{db.server}</span>
                    )}
                    {db.kind === 'influxdb' && db.version === 'v2' && db.org && (
                      <span className="badge badge-muted" style={{ fontSize: 10 }}>{db.org}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Retention + verify schedule summary */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="card" style={{ background: 'var(--surface-1)', padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                Retention
              </div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                Keep {policy.retention.count ?? '—'} backups
              </div>
            </div>
            <div className="card" style={{ background: 'var(--surface-1)', padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                Verify schedule
              </div>
              <div className="font-mono" style={{ fontSize: 12, fontWeight: 600 }}>
                {policy.verifySchedule || 'Disabled'}
              </div>
            </div>
          </div>

          {/* Recent runs */}
          <div>
            <label className="form-label" style={{ marginBottom: 6 }}>
              <Layers size={11} style={{ marginRight: 4, verticalAlign: 'text-top' }} />
              Recent runs
            </label>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                <Loader2 size={14} className="animate-spin" /> Loading…
              </div>
            ) : history.length === 0 ? (
              <div className="empty-state" style={{ padding: '24px 12px', fontSize: 13 }}>
                <Clock size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                <div>No runs yet — click <strong>Run now</strong> to make the first backup.</div>
              </div>
            ) : (
              <div className="card" style={{ background: 'var(--surface-1)', padding: 0, overflow: 'hidden' }}>
                {history.slice(0, 20).map((b, i) => (
                  <div
                    key={b.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px',
                      borderBottom: i < Math.min(history.length, 20) - 1 ? '1px solid var(--surface-4)' : 'none',
                      fontSize: 13,
                    }}
                  >
                    {b.status === 'success'
                      ? <CheckCircle2 size={14} color="var(--emerald)" style={{ flexShrink: 0 }} />
                      : <AlertCircle size={14} color="var(--rose)" style={{ flexShrink: 0 }} />}
                    <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {b.id.slice(0, 8)}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {new Date(b.timestamp).toLocaleString()}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                      {(b.duration / 1000).toFixed(1)}s
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Created {new Date(policy.createdAt).toLocaleDateString()}
            {policy.updatedAt && policy.updatedAt !== policy.createdAt && (
              <> · Updated {new Date(policy.updatedAt).toLocaleDateString()}</>
            )}
          </div>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

/* ── Stat tile sub-component ─────────────────────────────── */
interface StatTileProps {
  icon: React.ReactNode
  label: string
  value: string
  mono?: boolean
  subtitle?: string
}

const StatTile: React.FC<StatTileProps> = ({ icon, label, value, mono, subtitle }) => (
  <div className="card" style={{ background: 'var(--surface-1)', padding: 12 }}>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      fontSize: 11, color: 'var(--text-muted)',
      textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
    }}>
      {icon} {label}
    </div>
    <div
      className={mono ? 'font-mono' : ''}
      style={{
        fontSize: 13, fontWeight: 600,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
      title={subtitle ?? value}
    >
      {value}
    </div>
    {subtitle && (
      <div className="font-mono" style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
        {subtitle}
      </div>
    )}
  </div>
)
