import React, { useEffect, useState } from 'react'
import { getCostConfig, getPolicies, listAllBackups } from '../api'
import type { CostPreset, CostConfigResponse } from '../api'
import { openExternal } from '../utils/openExternal'
import {
  DollarSign, Clock, HardDrive, Cloud, Server, Lock, Database,
  Globe, TrendingUp, Info, Zap, Shield, ExternalLink,
} from 'lucide-react'

const ICON_MAP: Record<string, React.ReactNode> = {
  'hard-drive': <HardDrive size={18} />,
  'server': <Server size={18} />,
  'lock': <Lock size={18} />,
  'cloud': <Cloud size={18} />,
  'database': <Database size={18} />,
  'globe': <Globe size={18} />,
}

export const CostAnalysisPage: React.FC = () => {
  const [config, setConfig] = useState<CostPreset[]>([])
  const [meta, setMeta] = useState<{ lastUpdated: string; source: CostConfigResponse['source'] } | null>(null)
  const [policies, setPolicies] = useState<any[]>([])
  const [backups, setBackups] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [selectedSizeGB, setSelectedSizeGB] = useState(50)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const [c, p, b] = await Promise.all([
          getCostConfig().catch(() => null),
          getPolicies().catch(() => []),
          listAllBackups().catch(() => []),
        ])
        if (c && Array.isArray(c.presets)) {
          setConfig(c.presets)
          setMeta({ lastUpdated: c.lastUpdated, source: c.source })
        } else {
          setConfig([])
          setLoadError(true)
        }
        setPolicies(p as any[])
        setBackups(b as any[])
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const totalBackupSize = backups.reduce((sum, b) => sum + (b.size || 0), 0)
  const totalBackupSizeGB = totalBackupSize / (1024 * 1024 * 1024)

  const fmtCost = (n: number) => {
    if (n === 0) return 'Free'
    if (n < 0.01) return `$${n.toFixed(4)}`
    return `$${n.toFixed(2)}`
  }

  const fmtTime = (seconds: number) => {
    if (seconds < 60) return `${seconds.toFixed(0)}s`
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`
    return `${(seconds / 3600).toFixed(1)}h`
  }

  const restoreTimeFor = (speedMBps: number, sizeGB: number) => {
    if (speedMBps <= 0) return '—'
    const sizeMB = sizeGB * 1024
    return fmtTime(sizeMB / speedMBps)
  }

  const monthlyCostFor = (costPerGBMonth: number, sizeGB: number) => {
    return costPerGBMonth * sizeGB
  }

  const egressCostFor = (costPerGBDownload: number, sizeGB: number) => {
    return costPerGBDownload * sizeGB
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13, padding: '24px 0' }}>
        Loading cost analysis…
      </div>
    )
  }

  if (config.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Cost Analysis</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Compare restore costs and speeds across storage backends.
          </p>
        </div>
        <div className="empty-state card">
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {loadError
              ? <>Couldn't load pricing data. The backend may still be starting up — wait a few seconds and reopen this tab. Cost analysis ships with built-in reference pricing, so no configuration is required.</>
              : <>No pricing data available. Cost analysis normally ships with built-in reference pricing; you can also set the <code>DRK_COST_CONFIG</code> environment variable with JSON to override it for your providers.</>}
          </div>
        </div>
      </div>
    )
  }

  // Total estimated cost = one month of storage + one full restore (egress).
  const totalCostFor = (c: CostPreset) =>
    monthlyCostFor(c.costPerGBMonth, selectedSizeGB) + egressCostFor(c.costPerGBDownload, selectedSizeGB)

  // Self-hosted/local options are always $0, so an overall "cheapest" trivially
  // picks Local Disk and buries the cloud comparison this page exists for.
  // Split the two: free local/self-hosted vs cheapest paid off-site option.
  // "Off-site" = rows backed by a real vendor price (they carry a sourceUrl).
  const offsiteOptions = config.filter(c => !!c.sourceUrl)
  const cheapestOffsite = offsiteOptions.length
    ? offsiteOptions.reduce((best, c) => (totalCostFor(c) < totalCostFor(best) ? c : best))
    : null

  // Fastest among off-site options (local disk is always fastest but isn't a real backup target).
  const fastestOffsite = offsiteOptions.length
    ? offsiteOptions.reduce((best, c) => (c.restoreSpeedMBps > best.restoreSpeedMBps ? c : best))
    : null

  // Staleness guard: published third-party pricing drifts. If the bundled
  // dataset hasn't been re-reviewed in >180 days, warn rather than silently
  // asserting old numbers. User overrides (env) are the user's own problem.
  const STALE_AFTER_DAYS = 180
  const reviewedAt = meta?.lastUpdated ? new Date(meta.lastUpdated) : null
  const dataAgeDays = reviewedAt && !isNaN(reviewedAt.getTime())
    ? (Date.now() - reviewedAt.getTime()) / 86_400_000
    : null
  const isStale = meta?.source === 'bundled' && dataAgeDays !== null && dataAgeDays > STALE_AFTER_DAYS

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {isStale && (
        <div className="card" style={{
          background: 'var(--amber-dim, rgba(245,158,11,0.08))',
          border: '1px solid var(--amber-border, rgba(245,158,11,0.25))',
          display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12,
          lineHeight: 1.5, color: 'var(--text-secondary)',
        }}>
          <Info size={16} color="var(--amber, #f59e0b)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            This reference pricing was last reviewed on <strong>{meta?.lastUpdated}</strong>
            {' '}(over {Math.floor((dataAgeDays as number) / 30)} months ago) and may be out of date.
            Confirm current rates with each provider via the source links below.
          </span>
        </div>
      )}
      {/* Header */}
      <div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Cost Analysis</h2>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
          Compare restore costs and speeds across storage backends. Data is representative — actual pricing varies by provider and region.
        </p>
        {meta && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            <Clock size={11} />
            <span>
              {meta.source === 'env-override'
                ? <>Using your <code>DRK_COST_CONFIG</code> override</>
                : <>Built-in reference pricing</>}
              {meta.lastUpdated && <> · as of {meta.lastUpdated}</>}
            </span>
          </div>
        )}
      </div>

      {/* Size selector */}
      <div className="card" style={{ background: 'var(--surface-1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HardDrive size={15} color="var(--text-muted)" />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Data size for estimation:</span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[10, 50, 100, 500].map(size => (
              <button
                key={size}
                className={`btn ${selectedSizeGB === size ? 'btn-primary' : 'btn-ghost'}`}
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => setSelectedSizeGB(size)}
              >
                {size >= 1000 ? `${size / 1000}TB` : `${size}GB`}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {totalBackupSizeGB > 0 && (
              <span>Your actual backup size: <strong>{totalBackupSizeGB.toFixed(1)} GB</strong></span>
            )}
          </div>
        </div>
      </div>

      {/* Cost comparison cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {config.map(backend => {
          const monthlyCost = monthlyCostFor(backend.costPerGBMonth, selectedSizeGB)
          const egressCost = egressCostFor(backend.costPerGBDownload, selectedSizeGB)
          const restoreTime = restoreTimeFor(backend.restoreSpeedMBps, selectedSizeGB)
          const isFree = backend.costPerGBMonth === 0 && backend.costPerGBDownload === 0

          return (
            <div key={backend.storageType} className="card" style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--surface-4)',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--surface-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-secondary)',
                }}>
                  {ICON_MAP[backend.icon] || <HardDrive size={18} />}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{backend.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{backend.storageType}</div>
                </div>
                {isFree && (
                  <span className="badge badge-success" style={{ marginLeft: 'auto', fontSize: 10 }}>No egress</span>
                )}
              </div>

              {/* Cost metrics */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
                    Monthly
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: monthlyCost > 0 ? 'var(--text-primary)' : 'var(--emerald)' }}>
                    {fmtCost(monthlyCost)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>per month</div>
                </div>
                <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
                    Egress
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: egressCost > 0 ? 'var(--amber)' : 'var(--emerald)' }}>
                    {fmtCost(egressCost)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>per restore</div>
                </div>
                <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
                    Restore
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{restoreTime}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>est. time</div>
                </div>
              </div>

              {/* Speed bar */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>
                  <span>Restore speed</span>
                  <span>{backend.restoreSpeedMBps} MB/s</span>
                </div>
                <div style={{ height: 4, background: 'var(--surface-3)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(100, (backend.restoreSpeedMBps / 500) * 100)}%`,
                    background: backend.restoreSpeedMBps >= 200 ? 'var(--emerald)'
                      : backend.restoreSpeedMBps >= 100 ? 'var(--blue-500, #3b82f6)'
                      : 'var(--amber)',
                    borderRadius: 2,
                    transition: 'width 0.3s',
                  }} />
                </div>
              </div>

              {/* Durability */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                <Shield size={11} />
                <span>{backend.durability}</span>
              </div>

              {/* Notes */}
              <div style={{
                fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4,
                padding: '6px 8px', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)',
                display: 'flex', alignItems: 'flex-start', gap: 5,
              }}>
                <Info size={11} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{backend.notes}</span>
              </div>

              {/* Source attribution — links to the vendor's official pricing page */}
              {backend.sourceUrl && (
                <button
                  className="btn btn-ghost"
                  onClick={() => openExternal(backend.sourceUrl!)}
                  title={backend.sourceUrl}
                  style={{
                    alignSelf: 'flex-start', fontSize: 10, padding: '2px 6px',
                    display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)',
                  }}
                >
                  <ExternalLink size={10} />
                  Vendor pricing{meta?.lastUpdated ? ` (as of ${meta.lastUpdated})` : ''}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Recommendation */}
      <div className="card" style={{
        background: 'var(--blue-dim, rgba(59,130,246,0.06))',
        border: '1px solid var(--blue-border, rgba(59,130,246,0.15))',
        display: 'flex', alignItems: 'flex-start', gap: 10,
      }}>
        <TrendingUp size={16} color="var(--blue-500, #3b82f6)" style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>Recommendation</div>
          {cheapestOffsite ? (
            <p style={{ margin: 0 }}>
              For <strong>{selectedSizeGB >= 1000 ? `${selectedSizeGB / 1000}TB` : `${selectedSizeGB}GB`}</strong> of backup data,
              the cheapest off-site option is <strong>{cheapestOffsite.label}</strong> at{' '}
              <strong>{fmtCost(totalCostFor(cheapestOffsite))}</strong> (one month of storage + one full restore).
            </p>
          ) : (
            <p style={{ margin: 0 }}>
              For <strong>{selectedSizeGB >= 1000 ? `${selectedSizeGB / 1000}TB` : `${selectedSizeGB}GB`}</strong>, costs are estimated per backend below.
            </p>
          )}
          <p style={{ margin: '6px 0 0' }}>
            Local Disk / NAS are free and fastest to restore, but they aren't off-site — keep at least one remote or cloud copy
            so a host failure can't take your backups with it.
          </p>
          {fastestOffsite && (
            <p style={{ margin: '6px 0 0' }}>
              Fastest off-site restore: <strong>{fastestOffsite.label}</strong> at{' '}
              <strong>{fastestOffsite.restoreSpeedMBps} MB/s</strong> (~{restoreTimeFor(fastestOffsite.restoreSpeedMBps, selectedSizeGB)} for this size).
            </p>
          )}
        </div>
      </div>

      {/* Disclaimer — accuracy + non-affiliation. Keep this honest: we publish
          third-party prices, so we date them, link the source, and hedge. */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, paddingBottom: 8 }}>
        {meta?.source === 'env-override' ? (
          <p style={{ margin: 0 }}>
            Showing your <code>DRK_COST_CONFIG</code> override. Figures are whatever you supplied.
          </p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              As of <strong>{meta?.lastUpdated ?? 'the last review'}</strong> we believe these prices are correct per each
              vendor's published pricing (use the <em>Vendor pricing</em> links above to confirm). Prices change frequently,
              vary by region/tier/usage, and are shown for rough comparison only — always verify with the provider before
              relying on them. Self-hosted options (Local, SMB, SFTP, Proxmox) have no vendor fee; rclone figures are a rough
              S3-equivalent estimate.
            </p>
            <p style={{ margin: '6px 0 0' }}>
              Docker Rescue Kit is not affiliated with, sponsored by, or endorsed by these vendors. All product names and
              trademarks belong to their respective owners. Override these defaults with the <code>DRK_COST_CONFIG</code> env
              var (JSON) for your own negotiated rates.
            </p>
          </>
        )}
      </div>
    </div>
  )
}