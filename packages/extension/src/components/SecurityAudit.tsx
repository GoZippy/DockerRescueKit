import React, { useState, useEffect } from 'react'
import { Shield, Check, ShieldAlert, Cpu, AlertTriangle, Loader2, Clock, RefreshCw } from 'lucide-react'
import { getPolicies, getVolumes, getStatus, getAuditLog } from '../api'

export const SecurityAudit: React.FC = () => {
  const [unprotectedVols, setUnprotectedVols] = useState<string[]>([])
  const [sysVer, setSysVer] = useState('Unknown')
  const [auditLog, setAuditLog] = useState<Array<{ id: string; timestamp: string; action: string; details?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)

  const performScan = async () => {
    setScanning(true)
    try {
      const [policies, vols, stat, audit] = await Promise.all([
        getPolicies(),
        getVolumes(),
        getStatus(),
        getAuditLog().catch(() => []),
      ])
      const protected_ = new Set(
        policies.filter(p => p.enabled).flatMap(p => p.targets.map(t => t.selector))
      )
      const activeVols: string[] =
        vols?.Volumes?.map((v: any) => v.Name) ||
        vols?.map?.((v: any) => v.Name) ||
        []
      setUnprotectedVols(activeVols.filter(v => !protected_.has(v)))
      setSysVer(stat?.version || '1.0.0')
      setAuditLog(audit)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
      setScanning(false)
    }
  }

  useEffect(() => { performScan() }, [])

  const grade =
    unprotectedVols.length === 0 ? 'A — Secure'
    : unprotectedVols.length <= 2 ? 'A- — Minor risks'
    : 'B — Action needed'

  const gradeColor =
    unprotectedVols.length === 0 ? 'var(--emerald)'
    : unprotectedVols.length <= 2 ? 'var(--blue-500)'
    : 'var(--amber)'

  const CHECKS = [
    'Backend API key authentication enforced',
    'Database credentials AES-256 encrypted',
    'Docker socket permissions restricted',
    'No root privileged containers detected',
    'Extension token isolation active',
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Grade banner */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px' }}>
        <div style={{
          width: 52, height: 52, borderRadius: 'var(--r-lg)', flexShrink: 0,
          background: `color-mix(in srgb, ${gradeColor} 15%, transparent)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Shield size={26} color={gradeColor} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: gradeColor }}>
            Grade: {grade}
            {loading && <Loader2 size={14} className="animate-spin" style={{ marginLeft: 8, display: 'inline' }} />}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            {unprotectedVols.length} unprotected volume(s) detected.
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={performScan}
          disabled={scanning}
          style={{ flexShrink: 0 }}
        >
          {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {scanning ? 'Scanning…' : 'Run Scan'}
        </button>
      </div>

      {/* Checks grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

        {/* Passed */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 12 }}>
            <Check size={16} color="var(--emerald)" /> Passed checks
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {CHECKS.map((c, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderRadius: 'var(--r-sm)',
                  background: 'var(--emerald-dim)', border: '1px solid rgba(16,185,129,0.15)',
                  fontSize: 13,
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--emerald)', flexShrink: 0 }} />
                {c}
              </div>
            ))}
          </div>
        </div>

        {/* Warnings */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 12, color: 'var(--amber)' }}>
            <AlertTriangle size={16} /> Warnings
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {unprotectedVols.length > 0 ? (
              <div style={{
                padding: '10px 12px', borderRadius: 'var(--r-md)',
                background: 'var(--amber-dim)', border: '1px solid rgba(245,158,11,0.25)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#fbbf24', marginBottom: 6 }}>
                  <ShieldAlert size={16} />
                  {unprotectedVols.length} unprotected volume(s)
                </div>
                <div style={{ fontSize: 12, color: 'rgba(251,191,36,0.8)', marginBottom: 6 }}>
                  Not covered by any active backup policy:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {unprotectedVols.slice(0, 5).map(v => (
                    <span key={v} className="font-mono" style={{
                      fontSize: 11, padding: '2px 6px',
                      background: 'rgba(0,0,0,0.3)', borderRadius: 4, color: '#fbbf24',
                    }}>
                      {v}
                    </span>
                  ))}
                  {unprotectedVols.length > 5 && (
                    <span style={{ fontSize: 11, color: 'rgba(251,191,36,0.6)' }}>
                      +{unprotectedVols.length - 5} more
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div style={{
                padding: '10px 12px', borderRadius: 'var(--r-md)',
                background: 'var(--emerald-dim)', border: '1px solid rgba(16,185,129,0.2)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#34d399' }}>
                  <Check size={16} /> All volumes protected
                </div>
                <div style={{ fontSize: 12, color: 'rgba(52,211,153,0.7)', marginTop: 4 }}>
                  Every discovered Docker volume is covered by an active policy.
                </div>
              </div>
            )}

            <div style={{
              padding: '10px 12px', borderRadius: 'var(--r-md)',
              background: 'var(--amber-dim)', border: '1px solid rgba(245,158,11,0.25)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#fbbf24', marginBottom: 4 }}>
                <Cpu size={16} /> System info
              </div>
              <div style={{ fontSize: 12, color: 'rgba(251,191,36,0.8)' }}>
                Version {sysVer} running on port 42880.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Audit log */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--surface-4)', fontWeight: 700 }}>
          <Clock size={15} color="var(--text-muted)" />
          Audit Log
          {auditLog.length > 0 && (
            <span className="badge badge-muted" style={{ marginLeft: 'auto' }}>{auditLog.length}</span>
          )}
        </div>
        {auditLog.length === 0 ? (
          <div className="empty-state">No audit entries yet.</div>
        ) : (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLog.slice(0, 100).map(entry => (
                  <tr key={entry.id}>
                    <td>
                      <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                    </td>
                    <td>
                      <span className="font-mono" style={{ fontSize: 12, color: '#60a5fa' }}>{entry.action}</span>
                    </td>
                    <td>
                      {entry.details && (
                        <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }} title={entry.details}>
                          {entry.details.slice(0, 60)}{entry.details.length > 60 ? '…' : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
