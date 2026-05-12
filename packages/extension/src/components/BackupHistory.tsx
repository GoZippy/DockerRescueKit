import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { Backup } from '@docker-rescue-kit/shared'
import { listAllBackups, deleteBackup, verifyBackup } from '../api'
import {
  CheckCircle2, AlertCircle, Clock, Play, Trash2,
  RefreshCw, Folder, ShieldCheck, Loader2, X,
} from 'lucide-react'
import { RestoreWizard } from './RestoreWizard'
import { PartialRestoreBrowser } from './PartialRestoreBrowser'
import { PageError, PageErrorKind } from './PageError'
import { useToast } from '../hooks/useToast'

const fmt = (b: number) => {
  if (!b) return '—'
  const k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(b) / Math.log(k))
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i]
}

const ago = (ts: Date | string) => {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const BackupHistory: React.FC = () => {
  const [backups, setBackups] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<Backup | null>(null)
  const [browsing, setBrowsing] = useState<Backup | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [verifyReport, setVerifyReport] = useState<any>(null)
  const [filterStatus, setFilterStatus] = useState<'all' | 'success' | 'failed' | 'running'>('all')
  const [filterPolicy, setFilterPolicy] = useState('')
  const [filterTag, setFilterTag] = useState('')
  const [search, setSearch] = useState('')
  const [errorKind, setErrorKind] = useState<PageErrorKind | null>(null)
  const toast = useToast()

  const load = async () => {
    setLoading(true)
    setErrorKind(null)
    try {
      setBackups(await listAllBackups())
    } catch (e) {
      console.error('Failed to load backups', e)
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

  const onDelete = async (id: string) => {
    if (!confirm('Delete this backup permanently?')) return
    try {
      await deleteBackup(id)
      toast.push('success', 'Backup deleted')
      load()
    } catch (e: any) {
      const msg = axios.isAxiosError(e)
        ? (e.response?.data?.error || e.message)
        : (e?.message || 'Unknown error')
      toast.push('error', `Delete failed: ${msg}`)
    }
  }

  const onVerify = async (id: string) => {
    setVerifying(id)
    setVerifyReport(null)
    try {
      const report = await verifyBackup(id)
      setVerifyReport(report)
      if (report?.ok) {
        toast.push('success', 'Verification passed')
      } else {
        toast.push('warning', 'Verification finished with failures')
      }
    } catch (e: any) {
      const msg = axios.isAxiosError(e)
        ? (e.response?.data?.error || e.message)
        : (e?.message || 'Unknown error')
      setVerifyReport({ ok: false, steps: [{ label: 'verify', ok: false, detail: msg }] })
      toast.push('error', `Verify failed: ${msg}`)
    } finally {
      setVerifying(null)
    }
  }

  const filtered = backups.filter(b => {
    if (filterStatus !== 'all' && b.status !== filterStatus) return false
    if (filterPolicy && b.policyId !== filterPolicy) return false
    if (filterTag && !(b.tags || []).includes(filterTag)) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        b.id.toLowerCase().includes(q) ||
        (b.error || '').toLowerCase().includes(q) ||
        b.targets.some(t => t.selector.toLowerCase().includes(q))
      )
    }
    return true
  })

  const allPolicies = Array.from(new Set(backups.map(b => b.policyId)))
  const allTags = Array.from(new Set(backups.flatMap(b => b.tags || [])))

  const statusIcon = (status: string) => {
    if (status === 'success') return <CheckCircle2 size={15} color="var(--emerald)" />
    if (status === 'failed')  return <AlertCircle  size={15} color="var(--rose)" />
    return <Clock size={15} color="var(--amber)" className="animate-pulse" />
  }

  if (errorKind) {
    return (
      <PageError
        kind={errorKind}
        title={errorKind === 'unknown' ? 'Failed to load backups' : undefined}
        onRetry={load}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Filter bar */}
      <div className="card" style={{ padding: '10px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Search */}
        <input
          className="form-input"
          style={{ minWidth: 180, flex: '1 1 180px', maxWidth: 280 }}
          placeholder="Search ID / selector / error…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="form-select"
          style={{ minWidth: 130, flex: '0 0 auto' }}
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value as any)}
        >
          <option value="all">All statuses</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
        </select>
        <select
          className="form-select"
          style={{ minWidth: 130, flex: '0 0 auto' }}
          value={filterPolicy}
          onChange={e => setFilterPolicy(e.target.value)}
        >
          <option value="">All policies</option>
          {allPolicies.map(p => (
            <option key={p} value={p}>{p.slice(0, 12)}</option>
          ))}
        </select>
        {allTags.length > 0 && (
          <select
            className="form-select"
            style={{ minWidth: 110, flex: '0 0 auto' }}
            value={filterTag}
            onChange={e => setFilterTag(e.target.value)}
          >
            <option value="">All tags</option>
            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <button className="btn btn-ghost" onClick={load} title="Refresh" style={{ marginLeft: 'auto', flexShrink: 0 }}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>

        {/* Result count */}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
          {filtered.length} / {backups.length}
        </span>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, gap: 8, color: 'var(--text-muted)' }}>
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state card">
          {backups.length === 0
            ? 'No backups yet. Create a policy and run it once.'
            : 'No backups match the current filters.'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 24 }}></th>
                  <th>ID</th>
                  <th>Policy</th>
                  <th>When</th>
                  <th>Size</th>
                  <th>Dur.</th>
                  <th>Tags</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(b => (
                  <tr key={b.id}>
                    <td>{statusIcon(b.status)}</td>
                    <td>
                      <span className="font-mono" style={{ fontSize: 12 }}>{b.id.slice(0, 8)}</span>
                      {b.error && (
                        <div style={{ fontSize: 11, color: 'var(--rose)', marginTop: 2 }} title={b.error}>
                          {b.error.slice(0, 40)}{b.error.length > 40 ? '…' : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        {b.policyId?.slice(0, 10)}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }} title={new Date(b.timestamp).toLocaleString()}>
                        {ago(b.timestamp)}
                      </span>
                    </td>
                    <td><span style={{ fontSize: 12 }}>{fmt(b.size)}</span></td>
                    <td>
                      <span style={{ fontSize: 12 }}>
                        {b.duration ? `${(b.duration / 1000).toFixed(1)}s` : '—'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                        {(b.tags || []).map(t => (
                          <span key={t} className="badge badge-muted">{t}</span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
                        {b.status === 'success' && (
                          <>
                            <button
                              className="btn-icon"
                              onClick={() => setBrowsing(b)}
                              title="Browse files"
                            >
                              <Folder size={14} />
                            </button>
                            <button
                              className="btn-icon"
                              onClick={() => onVerify(b.id)}
                              disabled={verifying === b.id}
                              title="Verify backup"
                              style={{ color: verifying === b.id ? '#60a5fa' : undefined }}
                            >
                              {verifying === b.id
                                ? <Loader2 size={14} className="animate-spin" />
                                : <ShieldCheck size={14} />}
                            </button>
                            <button
                              className="btn btn-primary"
                              style={{ padding: '4px 8px', fontSize: 11 }}
                              onClick={() => setRestoring(b)}
                            >
                              <Play size={12} /> Restore
                            </button>
                          </>
                        )}
                        <button
                          className="btn-icon"
                          onClick={() => onDelete(b.id)}
                          title="Delete"
                          style={{ color: 'var(--text-muted)' }}
                          onMouseEnter={e => (e.currentTarget.style.color = 'var(--rose)')}
                          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Restore wizard */}
      {restoring && (
        <RestoreWizard
          backup={restoring}
          onClose={() => setRestoring(null)}
          onDone={() => { setRestoring(null); load() }}
        />
      )}

      {/* File browser */}
      {browsing && (
        <PartialRestoreBrowser
          backup={browsing}
          onClose={() => setBrowsing(null)}
        />
      )}

      {/* Verify report modal */}
      {verifyReport && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => setVerifyReport(null)}
        >
          <div
            className="card"
            style={{ maxWidth: 500, width: '100%', padding: 20 }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
                {verifyReport.ok
                  ? <CheckCircle2 size={18} color="var(--emerald)" />
                  : <AlertCircle  size={18} color="var(--rose)" />}
                Verification {verifyReport.ok ? 'passed' : 'failed'}
              </div>
              <button className="btn-icon" onClick={() => setVerifyReport(null)}><X size={16} /></button>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12, maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {(verifyReport.steps || []).map((s: any, i: number) => (
                <li key={i} style={{ color: s.ok ? '#34d399' : '#fb7185', fontFamily: 'monospace' }}>
                  [{s.ok ? 'ok' : 'fail'}] {s.label}{s.detail ? ` — ${s.detail}` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
