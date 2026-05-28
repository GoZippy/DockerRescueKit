import React, { useEffect, useState } from 'react'
import { getCostConfig, getPolicies, listAllBackups } from '../api'
import {
  DollarSign, Clock, HardDrive, Cloud, Server, Lock, Database,
  Globe, TrendingUp, Info, Zap, Shield,
} from 'lucide-react'

const ICON_MAP: Record<string, React.ReactNode> = {
  'hard-drive': <HardDrive size={18} />,
  'server': <Server size={18} />,
  'lock': <Lock size={18} />,
  'cloud': <Cloud size={18} />,
  'database': <Database size={18} />,
  'globe': <Globe size={18} />,
}

interface CostConfig {
  storageType: string
  label: string
  icon: string
  costPerGBMonth: number
  costPerGBDownload: number
  restoreSpeedMBps: number
  durability: string
  notes: string
}

export const CostAnalysisPage: React.FC = () => {
  const [config, setConfig] = useState<CostConfig[]>([])
  const [policies, setPolicies] = useState<any[]>([])
  const [backups, setBackups] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSizeGB, setSelectedSizeGB] = useState(50)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        const [c, p, b] = await Promise.all([
          getCostConfig().catch(() => []),
          getPolicies().catch(() => []),
          listAllBackups().catch(() => []),
        ])
        setConfig(Array.isArray(c) ? (c as CostConfig[]) : [])
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
            No cost configuration available. Set the <code>DRK_COST_CONFIG</code> environment variable with JSON data to enable cost analysis.
          </div>
        </div>
      </div>
    )
  }

  const cheapest = config.reduce((best, c) => {
    const cost = monthlyCostFor(c.costPerGBMonth, selectedSizeGB) + egressCostFor(c.costPerGBDownload, selectedSizeGB)
    const bestCost = monthlyCostFor(best.costPerGBMonth, selectedSizeGB) + egressCostFor(best.costPerGBDownload, selectedSizeGB)
    return cost < bestCost ? c : best
  }, config[0])

  const fastest = config.reduce((best, c) => c.restoreSpeedMBps > best.restoreSpeedMBps ? c : best, config[0])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Cost Analysis</h2>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
          Compare restore costs and speeds across storage backends. Data is representative — actual pricing varies by provider and region.
        </p>
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
          <p style={{ margin: 0 }}>
            For <strong>{selectedSizeGB >= 1000 ? `${selectedSizeGB / 1000}TB` : `${selectedSizeGB}GB`}</strong> of backup data,
            the cheapest long-term option is <strong>{cheapest.label}</strong> with a total estimated cost of{' '}
            <strong>{fmtCost(monthlyCostFor(cheapest.costPerGBMonth, selectedSizeGB) + egressCostFor(cheapest.costPerGBDownload, selectedSizeGB))}</strong>{' '}
            (monthly storage + one restore).
          </p>
          <p style={{ margin: '6px 0 0' }}>
            For the fastest restore, use <strong>{fastest.label}</strong> at{' '}
            <strong>{fastest.restoreSpeedMBps} MB/s</strong> (~{restoreTimeFor(fastest.restoreSpeedMBps, selectedSizeGB)}).
          </p>
        </div>
      </div>

      {/* Disclaimer */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', paddingBottom: 8 }}>
        Pricing is representative and based on AWS S3 Standard rates. Actual costs vary by provider, region, and usage tier.
        Configure <code>DRK_COST_CONFIG</code> env var with JSON to override for your specific providers.
      </div>
    </div>
  )
}