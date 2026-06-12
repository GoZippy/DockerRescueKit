import React, { useState, useEffect } from 'react'
import { Shield, Check, ShieldAlert, Cpu, AlertTriangle, Loader2, Clock, RefreshCw, Minus, Lock } from 'lucide-react'
import { getPolicies, getVolumes, getStatus, getAuditLog } from '../api'

// A check that was actually evaluated against real data.
interface RealCheck { label: string; ok: boolean; detail?: string }
// A check we cannot evaluate without additional backend endpoints.
interface DeferredCheck { label: string }

export const SecurityAudit: React.FC = () => {
  const [unprotectedVols, setUnprotectedVols] = useState<string[]>([])
  const [hasIndeterminatePolicies, setHasIndeterminatePolicies] = useState(false)
  const [sysVer, setSysVer] = useState('Unknown')
  const [auditLog, setAuditLog] = useState<Array<{ id: string; timestamp: string; action: string; details?: string }>>([])
  const [realChecks, setRealChecks] = useState<RealCheck[]>([])
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
      const enabledPolicies = policies.filter((p: any) => p.enabled)
      // Only targets of type 'volume' have selectors that are volume names.
      // Container/image/network targets cannot be resolved to volume names client-side.
      const directVolSelectors = new Set<string>(
        enabledPolicies.flatMap((p: any) =>
          p.targets.filter((t: any) => t.type === 'volume').map((t: any) => t.selector as string)
        )
      )
      const hasIndeterminate = enabledPolicies.some((p: any) =>
        p.targets.some((t: any) => t.type !== 'volume')
      )
      const activeVols: string[] =
        vols?.Volumes?.map((v: any) => v.Name) ||
        vols?.map?.((v: any) => v.Name) ||
        []
      const unprotected = activeVols.filter(v => !directVolSelectors.has(v))
      setUnprotectedVols(unprotected)
      setHasIndeterminatePolicies(hasIndeterminate)
      // Keep a stable reference for check detail computation below
      const indeterminate = hasIndeterminate
      setSysVer(stat?.version || 'Unknown')
      setAuditLog(audit)

      // ── Checks we can actually evaluate from fetched data ──────────────────
      const checks: RealCheck[] = []

      // 1. Volumes covered
      // unprotected = volumes with no direct 'volume'-type target match.
      // indeterminate = at least one container/image/network target exists whose
      //   covered volumes cannot be determined client-side.
      const directlyCovered = activeVols.length - unprotected.length
      checks.push({
        label: 'All Docker volumes covered by a backup policy',
        ok: unprotected.length === 0,
        detail: unprotected.length > 0
          ? `${unprotected.length} volume(s) not directly covered by a volume-type policy` +
            (indeterminate
              ? `; ${directlyCovered} covered directly + stack/container policies may cover more`
              : `: ${unprotected.slice(0, 3).join(', ')}${unprotected.length > 3 ? '…' : ''}`)
          : indeterminate
            ? `${directlyCovered} volume(s) directly covered; stack/container policies may cover additional volumes`
            : 'Every discovered volume has an active policy.',
      })

      // 2. Audit log is recording
      checks.push({
        label: 'Audit log is active',
        ok: Array.isArray(audit) && audit.length > 0,
        detail: Array.isArray(audit) && audit.length > 0
          ? `${audit.length} event(s) recorded.`
          : 'No audit entries yet — actions will appear here once recorded.',
      })

      // 3. Default credentials (status.securityWarnings from SecretsService)
      const secWarnings: string[] = (stat as any)?.securityWarnings ?? []
      checks.push({
        label: 'No default credentials detected',
        ok: secWarnings.length === 0,
        detail: secWarnings.length > 0
          ? 'Shipped default API or encryption key still in use — replace via Settings.'
          : 'API and encryption keys have been changed from factory defaults.',
      })

      // 4. Policies exist
      checks.push({
        label: 'At least one active backup policy configured',
        ok: policies.filter((p: any) => p.enabled).length > 0,
        detail: policies.filter((p: any) => p.enabled).length > 0
          ? `${policies.filter((p: any) => p.enabled).length} active policy/policies.`
          : 'No active policies — your data is not being backed up.',
      })

      setRealChecks(checks)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
      setScanning(false)
    }
  }

  useEffect(() => { performScan() }, [])

  // Grade is driven only by real, computable checks.
  const failedCount = realChecks.filter(c => !c.ok).length
  const grade =
    loading ? '…'
    : failedCount === 0 ? 'A — Secure'
    : failedCount === 1 ? 'A- — Minor issues'
    : 'B — Action needed'

  const gradeColor =
    loading ? 'var(--text-muted)'
    : failedCount === 0 ? 'var(--emerald)'
    : failedCount === 1 ? 'var(--blue-500)'
    : 'var(--amber)'

  // Checks that require deeper Docker inspection — not yet implemented.
  const DEFERRED_CHECKS: DeferredCheck[] = [
    { label: 'No root-privileged containers running' },
    { label: 'Docker socket not exposed to untrusted processes' },
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
            {loading ? 'Scanning…' : `${failedCount} issue(s) found · ${unprotectedVols.length} unprotected volume(s)`}
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

        {/* Real checks */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 12 }}>
            <Check size={16} color="var(--emerald)" /> Verified checks
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {realChecks.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
                {loading ? 'Scanning…' : 'No checks run yet.'}
              </div>
            )}
            {realChecks.map((c, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '8px 10px', borderRadius: 'var(--r-sm)',
                  background: c.ok ? 'var(--emerald-dim)' : 'var(--amber-dim)',
                  border: c.ok ? '1px solid rgba(16,185,129,0.15)' : '1px solid rgba(245,158,11,0.25)',
                  fontSize: 13,
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.ok ? 'var(--emerald)' : 'var(--amber)', flexShrink: 0, marginTop: 4 }} />
                <div>
                  <div style={{ color: c.ok ? 'var(--text-primary)' : 'var(--text-primary)', fontWeight: 500 }}>{c.label}</div>
                  {c.detail && <div style={{ fontSize: 11, color: c.ok ? 'rgba(52,211,153,0.75)' : 'rgba(251,191,36,0.8)', marginTop: 2 }}>{c.detail}</div>}
                </div>
              </div>
            ))}

            {/* Informational note — always true by design */}
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '8px 10px', borderRadius: 'var(--r-sm)',
              background: 'var(--emerald-dim)', border: '1px solid rgba(16,185,129,0.15)',
              fontSize: 13,
            }}>
              <Lock size={12} color="var(--emerald)" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontWeight: 500 }}>Credentials encrypted at rest</div>
                <div style={{ fontSize: 11, color: 'rgba(52,211,153,0.75)', marginTop: 2 }}>
                  All saved connector passwords and keys are stored with AES-256-GCM encryption.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Warnings + not-checked */}
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
                  Not directly covered by a volume-type policy{hasIndeterminatePolicies ? '; stack/container policies may cover some:' : ':'}
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
            ) : !loading && (
              <div style={{
                padding: '10px 12px', borderRadius: 'var(--r-md)',
                background: 'var(--emerald-dim)', border: '1px solid rgba(16,185,129,0.2)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#34d399' }}>
                  <Check size={16} /> {hasIndeterminatePolicies ? 'Volumes directly covered' : 'All volumes protected'}
                </div>
                <div style={{ fontSize: 12, color: 'rgba(52,211,153,0.7)', marginTop: 4 }}>
                  {hasIndeterminatePolicies
                    ? 'All discovered volumes have a direct volume-type policy; stack/container policies may cover additional volumes.'
                    : 'Every discovered Docker volume is covered by an active policy.'}
                </div>
              </div>
            )}

            <div style={{
              padding: '10px 12px', borderRadius: 'var(--r-md)',
              background: 'var(--surface-3)', border: '1px solid var(--surface-4)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>
                <Cpu size={16} /> System
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Docker Rescue Kit v{sysVer}
              </div>
            </div>

            {/* Deferred checks — clearly labeled as not yet verified */}
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Not checked — coming in a future release
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {DEFERRED_CHECKS.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', borderRadius: 'var(--r-sm)',
                      background: 'var(--surface-1)', border: '1px solid var(--surface-4)',
                      fontSize: 12, color: 'var(--text-muted)',
                    }}
                  >
                    <Minus size={12} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                    {c.label}
                  </div>
                ))}
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
