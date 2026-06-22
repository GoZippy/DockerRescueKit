import React, { useState, useEffect } from 'react'
import {
  Activity, Database, HardDrive, Server,
  Play, Layers, Plus, RefreshCw, CheckCircle2, AlertCircle, Clock,
  Cpu, TrendingUp, WifiOff, KeyRound, RotateCcw, LayoutGrid, Check,
} from 'lucide-react'
import axios from 'axios'
import { BackupPolicy, Backup } from '@docker-rescue-kit/shared'
import {
  getPolicies, getStatus, getTelemetry, listAllBackups, getContainers, runPolicy
} from '../api'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Filler, Legend
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { SortableGrid, SortableWidget } from './SortableGrid'
import { GuardRecentStrip } from './GuardRecentStrip'
import { GuardSettingsCard } from './GuardSettingsCard'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Filler, Legend)

const fmt = (bytes: number) => {
  if (!bytes) return '0 B'
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

const ago = (ts: Date | string) => {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

interface DashboardProps {
  onNavigate?: (tab: string) => void
}

type ErrorKind = 'auth' | 'docker-offline' | 'unknown' | null

// ── Draggable widget layout ──────────────────────────────────
// Order is persisted per browser so a user's arrangement survives reloads.
const DASH_ORDER_KEY = 'drk.dashboard.order'
const DEFAULT_ORDER = ['stats', 'guard-strip', 'trends', 'controls', 'recent', 'guard-settings']

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(DASH_ORDER_KEY)
    if (!raw) return DEFAULT_ORDER
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_ORDER
    // Keep only known ids, then append any new widgets not yet in the saved order
    // (forward-compatible if widgets are added/removed in a later version).
    const kept = parsed.filter((id: unknown): id is string =>
      typeof id === 'string' && DEFAULT_ORDER.includes(id))
    for (const id of DEFAULT_ORDER) if (!kept.includes(id)) kept.push(id)
    return kept.length ? kept : DEFAULT_ORDER
  } catch {
    return DEFAULT_ORDER
  }
}

export const Dashboard: React.FC<DashboardProps> = ({ onNavigate }) => {
  const [policies, setPolicies] = useState<BackupPolicy[]>([])
  const [backups, setBackups] = useState<Backup[]>([])
  const [containerCount, setContainerCount] = useState(0)
  const [sysStatus, setSysStatus] = useState<any>(null)
  const [telemetry, setTelemetry] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [errorKind, setErrorKind] = useState<ErrorKind>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [order, setOrder] = useState<string[]>(loadOrder)
  const [editing, setEditing] = useState(false)

  const applyOrder = (next: string[]) => {
    setOrder(next)
    try { localStorage.setItem(DASH_ORDER_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  }
  const isCustomOrder = order.join('|') !== DEFAULT_ORDER.join('|')

  const load = async () => {
    setLoading(true)
    setErrorKind(null)
    try {
      const [pol, stat, tel, bk, cs] = await Promise.all([
        getPolicies(),
        getStatus(),
        getTelemetry().catch(() => null),
        listAllBackups().catch(() => []),
        getContainers().catch(() => []),
      ])
      setPolicies(pol)
      setSysStatus(stat)
      setTelemetry(tel)
      setBackups(bk)
      setContainerCount(Array.isArray(cs) ? cs.length : 0)
    } catch (e) {
      console.error('Dashboard load failed', e)
      if (axios.isAxiosError(e)) {
        if (e.response?.status === 401) {
          setErrorKind('auth')
        } else if (e.response?.status === 503) {
          setErrorKind('docker-offline')
        } else {
          setErrorKind('unknown')
        }
      } else {
        setErrorKind('unknown')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(async () => {
      try { setTelemetry(await getTelemetry()) } catch {}
    }, 5000)
    return () => clearInterval(t)
  }, [])

  const activeCount = policies.filter(p => p.enabled).length
  const protectedCount = policies.reduce((a, p) => a + p.targets.length, 0)
  const successBackups = backups.filter(b => b.status === 'success')
  const totalBytes = successBackups.reduce((a, b) => a + (b.size || 0), 0)
  const lastBackup = backups.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )[0]

  // 7-day chart data
  const now = new Date()
  const dayLabels: string[] = []
  const dayBytes: number[] = []
  const dayDurations: number[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    d.setHours(0, 0, 0, 0)
    const next = new Date(d)
    next.setDate(d.getDate() + 1)
    const day = successBackups.filter(b => {
      const t = new Date(b.timestamp).getTime()
      return t >= d.getTime() && t < next.getTime()
    })
    dayLabels.push(d.toLocaleDateString(undefined, { weekday: 'short' }))
    dayBytes.push(+(day.reduce((a, b) => a + (b.size || 0), 0) / 1073741824).toFixed(2))
    dayDurations.push(day.length ? +(day.reduce((a, b) => a + (b.duration || 0), 0) / day.length / 1000).toFixed(1) : 0)
  }

  const chartData = {
    labels: dayLabels,
    datasets: [
      {
        fill: true,
        label: 'GB/day',
        data: dayBytes,
        borderColor: 'rgba(99,102,241,1)',
        backgroundColor: 'rgba(99,102,241,0.08)',
        tension: 0.4,
        yAxisID: 'y',
        pointRadius: 3,
        pointBackgroundColor: 'rgba(99,102,241,1)',
      },
      {
        fill: false,
        label: 'Avg sec',
        data: dayDurations,
        borderColor: 'rgba(56,189,248,1)',
        backgroundColor: 'rgba(56,189,248,0.1)',
        tension: 0.4,
        yAxisID: 'y1',
        pointRadius: 3,
        pointBackgroundColor: 'rgba(56,189,248,1)',
      },
    ],
  }

  const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: { position: 'top' as const, labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } } },
      title: { display: false },
      tooltip: { backgroundColor: '#1f2937', titleColor: '#f1f5f9', bodyColor: '#94a3b8' },
    },
    scales: {
      y:  { type: 'linear' as const, position: 'left'  as const, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 11 } }, title: { display: true, text: 'GB', color: '#475569', font: { size: 10 } } },
      y1: { type: 'linear' as const, position: 'right' as const, grid: { display: false }, ticks: { color: '#64748b', font: { size: 11 } }, title: { display: true, text: 'sec', color: '#475569', font: { size: 10 } } },
      x:  { grid: { display: false }, ticks: { color: '#64748b', font: { size: 11 } } },
    },
  }

  const recentRuns = [...backups]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 5)

  const handleRunAll = async () => {
    const enabled = policies.filter(p => p.enabled)
    for (const p of enabled) {
      setRunningId(p.id)
      try { await runPolicy(p.id) } catch {}
    }
    setRunningId(null)
    load()
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: 'var(--text-muted)', gap: 8 }}>
        <RefreshCw size={16} className="animate-spin" /> Loading dashboard…
      </div>
    )
  }

  if (errorKind === 'auth') {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: 300, gap: 16, textAlign: 'center',
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12,
          background: 'var(--rose-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <KeyRound size={24} color="var(--rose)" />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Invalid API key</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 320 }}>
            The stored API key was rejected by the server. Update it in Settings.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => onNavigate?.('settings')}>
            Go to Settings
          </button>
          <button className="btn btn-ghost" onClick={load}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      </div>
    )
  }

  if (errorKind === 'docker-offline') {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: 300, gap: 16, textAlign: 'center',
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12,
          background: 'var(--amber-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <WifiOff size={24} color="var(--amber)" />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Docker daemon offline</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 320 }}>
            The backend cannot reach the Docker daemon. Make sure Docker is running and the socket is mounted.
          </div>
        </div>
        <button className="btn btn-primary" onClick={load}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    )
  }

  if (errorKind === 'unknown') {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: 300, gap: 16, textAlign: 'center',
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12,
          background: 'var(--rose-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <AlertCircle size={24} color="var(--rose)" />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Failed to load dashboard</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 320 }}>
            An unexpected error occurred. Check the backend logs for details.
          </div>
        </div>
        <button className="btn btn-primary" onClick={load}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    )
  }

  // ── Widget definitions (rendered through the draggable grid) ──
  const statsNode = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
      <div className="stat-card">
        <div className="stat-card-icon" style={{ background: 'var(--blue-dim)' }}>
          <Database size={20} color="var(--blue-500)" />
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{activeCount}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Active Policies</div>
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-card-icon" style={{ background: 'var(--emerald-dim)' }}>
          <HardDrive size={20} color="var(--emerald)" />
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{protectedCount}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Protected Targets</div>
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-card-icon" style={{ background: 'var(--indigo-dim)' }}>
          <TrendingUp size={20} color="var(--indigo)" />
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{fmt(totalBytes)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Total Backup Size</div>
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-card-icon" style={{
          background: sysStatus === null ? 'var(--surface-3)' : sysStatus?.docker ? 'var(--emerald-dim)' : 'var(--rose-dim)'
        }}>
          <Server size={20} color={sysStatus === null ? 'var(--text-muted)' : sysStatus?.docker ? 'var(--emerald)' : 'var(--rose)'} />
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, color: sysStatus === null ? 'var(--text-muted)' : sysStatus?.docker ? '#34d399' : '#fb7185' }}>
            {sysStatus === null ? '—' : sysStatus.docker ? 'Online' : 'Offline'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Docker · {containerCount} {containerCount === 1 ? 'container' : 'containers'}
          </div>
        </div>
      </div>
    </div>
  )

  const trendsNode = (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 240, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Activity size={16} color="var(--indigo)" />
        <span style={{ fontWeight: 700, fontSize: 13 }}>Backup Trends — 7 days</span>
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 180 }}>
        <Line options={chartOpts} data={chartData} />
      </div>
    </div>
  )

  const controlsNode = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Quick Actions</span>
        <button
          className="btn btn-primary"
          style={{ justifyContent: 'flex-start' }}
          onClick={handleRunAll}
          disabled={!!runningId || activeCount === 0}
        >
          <Play size={14} />
          {runningId ? 'Running…' : 'Run All Policies'}
        </button>
        <button
          className="btn btn-ghost"
          style={{ justifyContent: 'flex-start' }}
          onClick={() => onNavigate?.('stacks')}
        >
          <Layers size={14} /> Protect a Stack
        </button>
        <button
          className="btn btn-ghost"
          style={{ justifyContent: 'flex-start' }}
          onClick={() => onNavigate?.('policies')}
        >
          <Plus size={14} /> New Policy Wizard
        </button>
      </div>

      {/* Telemetry mini-card */}
      {telemetry && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Cpu size={14} color="var(--text-muted)" />
            <span style={{ fontWeight: 700, fontSize: 12 }}>Node Telemetry</span>
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Memory</span>
              <span className="font-mono" style={{ color: '#34d399', fontSize: 11 }}>
                {telemetry.memory?.percent ?? 0}%
              </span>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${telemetry.memory?.percent ?? 0}%`, background: 'var(--emerald)' }} />
            </div>
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>CPU</span>
              <span className="font-mono" style={{ color: '#fbbf24', fontSize: 11 }}>
                {telemetry.cpu?.loadPercent ?? 0}%
              </span>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${telemetry.cpu?.loadPercent ?? 0}%`, background: 'linear-gradient(to right, var(--amber), var(--rose))' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )

  const recentNode = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--surface-4)' }}>
          <Clock size={15} color="var(--text-muted)" />
          <span style={{ fontWeight: 700, fontSize: 13 }}>Recent Backup Runs</span>
          <span className="badge badge-muted" style={{ marginLeft: 'auto' }}>Last 5</span>
        </div>
        {recentRuns.length === 0 ? (
          <div className="empty-state">No backup runs yet. Create a policy and run it.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Backup ID</th>
                  <th>Policy</th>
                  <th>When</th>
                  <th>Size</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map(b => (
                  <tr key={b.id}>
                    <td>
                      {b.status === 'success' ? (
                        <CheckCircle2 size={15} color="var(--emerald)" />
                      ) : b.status === 'failed' ? (
                        <AlertCircle size={15} color="var(--rose)" />
                      ) : (
                        <Clock size={15} color="var(--amber)" />
                      )}
                    </td>
                    <td><span className="font-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{b.id.slice(0, 8)}</span></td>
                    <td><span style={{ fontSize: 12 }}>{b.policyId?.slice(0, 12)}</span></td>
                    <td><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ago(b.timestamp)}</span></td>
                    <td><span style={{ fontSize: 12 }}>{fmt(b.size)}</span></td>
                    <td><span style={{ fontSize: 12 }}>{(b.duration / 1000).toFixed(1)}s</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Last backup notice */}
      {lastBackup && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: 'var(--surface-2)', border: '1px solid var(--surface-4)',
          borderRadius: 'var(--r-md)', padding: '10px 14px', fontSize: 12,
        }}>
          <span className={`status-dot ${lastBackup.status}`} />
          <span style={{ color: 'var(--text-muted)' }}>Last backup:</span>
          <span className="font-mono">{lastBackup.id.slice(0, 8)}</span>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span>{ago(lastBackup.timestamp)}</span>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span>{fmt(lastBackup.size)}</span>
        </div>
      )}
    </div>
  )

  // Guard widgets: these self-hide when the backend isn't deployed (404).
  // They are pure components (no per-render data needed from Dashboard) so
  // wrapping them in a stable React element keeps the node reference stable
  // across re-renders and avoids remounting the underlying fetch effects.
  const guardStripNode = <GuardRecentStrip />
  const guardSettingsNode = <GuardSettingsCard />

  const widgetMap: Record<string, SortableWidget> = {
    stats:           { id: 'stats',          span: 12, label: 'summary stats',               node: statsNode },
    'guard-strip':   { id: 'guard-strip',    span: 12, label: 'recently saved snapshots',    node: guardStripNode },
    trends:          { id: 'trends',         span: 8,  label: 'backup trends chart',         node: trendsNode },
    controls:        { id: 'controls',       span: 4,  label: 'quick actions and telemetry', node: controlsNode },
    recent:          { id: 'recent',         span: 12, label: 'recent backup runs',          node: recentNode },
    'guard-settings':{ id: 'guard-settings', span: 12, label: 'prune guard settings',        node: guardSettingsNode },
  }
  const orderedWidgets = order.map(id => widgetMap[id]).filter(Boolean) as SortableWidget[]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Zero-state CTA: shown when no active policies (not draggable) ── */}
      {activeCount === 0 && (
        <div className="card" style={{
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          padding: 20,
          background: 'var(--blue-dim)',
          border: '1px solid var(--blue-border)',
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10, flexShrink: 0,
            background: 'var(--blue-500)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Database size={22} color="#fff" />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 3 }}>No active backup policies</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Start protecting your containers and volumes — it only takes a minute.
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ flexShrink: 0 }}
            onClick={() => onNavigate?.('stacks')}
          >
            <Layers size={14} /> Protect your first stack
          </button>
        </div>
      )}

      {/* Arrange toolbar — drag handles only appear once the user opts in, so
          nothing is ever layered over a live control during normal use. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {editing && 'Drag a panel to rearrange — or focus a handle and use the arrow keys. Changes save automatically.'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
          {editing && isCustomOrder && (
            <button
              className="btn btn-ghost"
              onClick={() => applyOrder(DEFAULT_ORDER)}
              style={{ fontSize: 12, padding: '5px 10px' }}
              title="Restore the default panel arrangement"
            >
              <RotateCcw size={13} /> Reset
            </button>
          )}
          <button
            className={editing ? 'btn btn-primary' : 'btn btn-ghost'}
            onClick={() => setEditing(e => !e)}
            style={{ fontSize: 12, padding: '5px 10px' }}
            title={editing ? 'Finish arranging panels' : 'Rearrange dashboard panels'}
            aria-pressed={editing}
          >
            {editing ? <><Check size={13} /> Done</> : <><LayoutGrid size={13} /> Arrange</>}
          </button>
        </div>
      </div>

      {/* Draggable, responsive widget grid */}
      <SortableGrid widgets={orderedWidgets} onReorder={applyOrder} editing={editing} columns={12} narrowBelow={720} />
    </div>
  )
}
