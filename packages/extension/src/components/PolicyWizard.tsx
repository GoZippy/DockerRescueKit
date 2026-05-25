import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  X, Save, ArrowRight, ArrowLeft, Layers, HardDrive,
  Box, Search, CheckSquare, Square, Server, Cloud, Network as NetIcon,
  HardDrive as DriveIcon, Wifi, Info,
} from 'lucide-react'
import {
  getVolumes, getContainers, listImages, listNetworks,
  listStacks, getConnectorInstances, createPolicy, updatePolicy,
} from '../api'
import { BackupPolicy } from '@docker-rescue-kit/shared'
import { CronPicker } from './CronPicker'

interface WizardProps {
  onClose: () => void
  onSuccess: () => void
  /** When provided, the wizard runs in edit mode: state is pre-filled from
   *  the policy and submit calls updatePolicy(id, ...) instead of createPolicy. */
  initialPolicy?: BackupPolicy
}

type TargetType = 'volume' | 'container' | 'image' | 'network'
interface TargetDraft { type: TargetType; selector: string }
interface Stack { project: string; containers: any[]; volumes: string[]; networks: string[] }

const SCHEDULE_PRESETS = [
  { label: 'Every hour',       desc: 'For critical, high-churn data',   cron: '0 * * * *' },
  { label: 'Every 6 hours',    desc: 'Frequent but not continuous',      cron: '0 */6 * * *' },
  { label: 'Daily at 02:00',   desc: 'Standard nightly backup',          cron: '0 2 * * *' },
  { label: 'Daily at 03:00',   desc: 'Offset nightly for load balancing',cron: '0 3 * * *' },
  { label: 'Weekly (Sun 04:00)',desc: 'Low-churn archive workloads',      cron: '0 4 * * 0' },
  { label: 'Monthly (1st)',    desc: 'Long-term retention snapshots',     cron: '0 5 1 * *' },
]

const VERIFY_PRESETS = [
  { label: 'None',             cron: '' },
  { label: 'Daily at 04:00',   cron: '0 4 * * *' },
  { label: 'Weekly (Sun)',      cron: '0 4 * * 0' },
  { label: 'Monthly',          cron: '0 4 1 * *' },
]

const STORAGE_TYPES = [
  { id: 'local',  label: 'Local disk',     desc: 'Files on the same host',         Icon: DriveIcon },
  { id: 's3',     label: 'S3 / B2 / MinIO',desc: 'Object storage with restic',     Icon: Cloud },
  { id: 'sftp',   label: 'SFTP',           desc: 'SSH file transfer protocol',     Icon: Wifi },
  { id: 'rclone', label: 'Rclone remote',  desc: 'Any rclone-supported backend',   Icon: Server },
  { id: 'smb',    label: 'SMB / CIFS',     desc: 'Windows shares / NAS',           Icon: NetIcon },
]

export const PolicyWizard: React.FC<WizardProps> = ({ onClose, onSuccess, initialPolicy }) => {
  const isEdit = !!initialPolicy
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [dockerOffline, setDockerOffline] = useState(false)

  const [volumes, setVolumes] = useState<string[]>([])
  const [containers, setContainers] = useState<string[]>([])
  const [images, setImages] = useState<string[]>([])
  const [networks, setNetworks] = useState<string[]>([])
  const [stacks, setStacks] = useState<Stack[]>([])
  const [connectors, setConnectors] = useState<any[]>([])
  const [targetSearch, setTargetSearch] = useState('')

  const [form, setForm] = useState(() => initialPolicy ? {
    name: initialPolicy.name,
    schedule: initialPolicy.schedule,
    verifySchedule: initialPolicy.verifySchedule || '',
    backupType: initialPolicy.backupType,
    retentionCount: initialPolicy.retention.count ?? 7,
    storageType: initialPolicy.storage.type,
    storageConnectorId: initialPolicy.storage.connectorId || '',
    targets: initialPolicy.targets.map(t => ({ type: t.type as TargetType, selector: t.selector })),
    enabled: initialPolicy.enabled,
  } : {
    name: '',
    schedule: '0 2 * * *',
    verifySchedule: '',
    backupType: 'full',
    retentionCount: 7,
    storageType: 'local',
    storageConnectorId: '',
    targets: [] as TargetDraft[],
    enabled: true,
  })

  const modalRef = useRef<HTMLDivElement>(null)

  // Lock body scroll while wizard is open
  useEffect(() => {
    document.body.classList.add('modal-open')
    return () => document.body.classList.remove('modal-open')
  }, [])

  // ESC-to-close + focus trap
  useEffect(() => {
    const root = modalRef.current
    if (!root) return
    const focusables = root.querySelectorAll<HTMLElement>(
      'input,button,select,textarea,a[href]'
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Tab' && focusables.length) {
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, step, loading])

  useEffect(() => {
    ;(async () => {
      try {
        const [vols, cs, imgs, nets, sts, conns] = await Promise.all([
          getVolumes().catch((e: any) => { if (e?.response?.data?.offline) setDockerOffline(true); return [] }),
          getContainers().catch(() => []),
          listImages().catch(() => []),
          listNetworks().catch(() => []),
          listStacks().catch(() => []),
          getConnectorInstances().catch(() => []),
        ])
        const volList = ((vols?.Volumes || vols || []) as any[]).map((v: any) => v.Name).filter(Boolean)
        if (volList.length === 0 && (cs as any[]).length === 0) setDockerOffline(true)
        setVolumes(volList)
        setContainers((cs as any[]).map((c: any) => (c.Names?.[0] || c.Id).replace(/^\//, '')))
        setImages((imgs as any[]).map((i: any) => (i.RepoTags?.[0] || i.Id)).filter(Boolean))
        setNetworks((nets as any[]).map((n: any) => n.Name).filter((n: string) => n && !['bridge','host','none'].includes(n)))
        setStacks(sts as Stack[])
        setConnectors(conns as any[])
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const isSelected = (t: TargetDraft) =>
    form.targets.some(x => x.type === t.type && x.selector === t.selector)

  const toggle = (t: TargetDraft) => {
    setForm(f => ({
      ...f,
      targets: isSelected(t)
        ? f.targets.filter(x => !(x.type === t.type && x.selector === t.selector))
        : [...f.targets, t],
    }))
  }

  const addStack = (s: Stack) => {
    const next: TargetDraft[] = [
      ...s.containers.map(c => ({
        type: 'container' as const,
        selector: (c.Names?.[0] || c.Id).replace(/^\//, '') as string,
      })),
      ...s.volumes.map(v => ({ type: 'volume' as const, selector: v })),
    ]
    const merged = [...form.targets]
    for (const t of next) {
      if (!merged.some(x => x.type === t.type && x.selector === t.selector)) merged.push(t)
    }
    setForm(f => ({ ...f, targets: merged, name: f.name || `stack-${s.project}` }))
  }

  const selectAllType = (type: TargetType, items: string[]) => {
    const all = items.map(s => ({ type, selector: s }))
    const allSelected = all.every(t => isSelected(t))
    if (allSelected) {
      setForm(f => ({ ...f, targets: f.targets.filter(x => x.type !== type) }))
    } else {
      const merged = [...form.targets]
      for (const t of all) {
        if (!merged.some(x => x.type === t.type && x.selector === t.selector)) merged.push(t)
      }
      setForm(f => ({ ...f, targets: merged }))
    }
  }

  const q = targetSearch.toLowerCase()
  const filterItems = (items: string[]) => q ? items.filter(i => i.toLowerCase().includes(q)) : items

  const fVols = useMemo(() => filterItems(volumes), [volumes, targetSearch])
  const fCons = useMemo(() => filterItems(containers), [containers, targetSearch])
  const fImgs = useMemo(() => filterItems(images), [images, targetSearch])
  const fNets = useMemo(() => filterItems(networks), [networks, targetSearch])

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const payload = {
        name: form.name || `policy-${Date.now()}`,
        enabled: form.enabled,
        targets: form.targets,
        schedule: form.schedule,
        verifySchedule: form.verifySchedule || undefined,
        backupType: form.backupType,
        retention: { strategy: 'count', count: form.retentionCount },
        storage: isEdit && initialPolicy ? {
          ...initialPolicy.storage,
          type: form.storageType,
          connectorId: form.storageConnectorId || undefined,
        } : {
          id: form.storageConnectorId || `storage-${Date.now()}`,
          type: form.storageType,
          path: 'data/backups',
          connectorId: form.storageConnectorId || undefined,
        },
      }
      if (isEdit && initialPolicy) {
        await updatePolicy(initialPolicy.id, payload)
      } else {
        await createPolicy(payload)
      }
      onSuccess()
    } catch (err) {
      console.error(err)
      alert(isEdit ? 'Failed to save policy' : 'Failed to create policy')
    } finally {
      setSubmitting(false)
    }
  }

  // Allow proceeding without targets if Docker is offline (can add targets later or manually)
  const canNext = step === 1 ? (form.targets.length > 0 || dockerOffline) : true

  const STEP_LABELS = ['Targets', 'Schedule', 'Storage & Review']

  // ENTER-to-submit on the final step
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return
    if (step === 3 && !submitting && form.targets.length > 0) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="modal-overlay" style={{ alignItems: 'flex-start', overflowY: 'auto' }}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-wizard-title"
        onKeyDown={onPanelKeyDown}
        className="modal-panel"
        style={{ maxWidth: 860, marginTop: 24, marginBottom: 24 }}
      >

        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span id="policy-wizard-title" style={{ fontWeight: 700, fontSize: 15 }}>
              {isEdit ? `Edit Policy — ${initialPolicy?.name}` : 'Create Protection Policy'}
            </span>
            {form.targets.length > 0 && (
              <span className="badge badge-info">{form.targets.length} targets</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Step indicator — compact pill row */}
            <div style={{ display: 'flex', gap: 4 }}>
              {STEP_LABELS.map((label, i) => (
                <div
                  key={i}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 100,
                    fontSize: 11,
                    fontWeight: 600,
                    background: step === i + 1 ? 'var(--blue-dim)' : 'transparent',
                    color: step === i + 1 ? '#60a5fa' : step > i + 1 ? '#34d399' : 'var(--text-muted)',
                    border: `1px solid ${step === i + 1 ? 'var(--blue-border)' : 'transparent'}`,
                  }}
                >
                  {i + 1}. {label}
                </div>
              ))}
            </div>
            <button className="btn-icon" onClick={onClose} aria-label="Close wizard"><X size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div className="modal-body">
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: 'var(--text-muted)', gap: 8 }}>
              Loading Docker context…
            </div>
          ) : (
            <>
              {/* ─── Step 1: TARGETS ─────────────────────────── */}
              {step === 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {/* Policy name */}
                  <div>
                    <label className="form-label">Policy name</label>
                    <input
                      className="form-input"
                      placeholder="e.g. nightly-app-db"
                      value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    />
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Info size={11} />
                      Choose a short, descriptive name. You can have multiple policies per stack — e.g. nightly-db + weekly-full.
                    </div>
                  </div>

                  {/* Docker offline banner */}
                  {dockerOffline && (
                    <div style={{
                      padding: '12px 16px',
                      background: 'var(--amber-dim)',
                      border: '1px solid rgba(245,158,11,0.3)',
                      borderRadius: 'var(--r-md)',
                      display: 'flex', alignItems: 'center', gap: 12,
                    }}>
                      <span style={{ fontSize: 13, color: '#fbbf24', flex: 1 }}>
                        Docker Desktop is offline — start Docker to see your volumes, containers, and stacks here.
                        You can still add targets manually below or continue to set up the schedule and storage.
                      </span>
                      <button className="btn btn-ghost" style={{ fontSize: 12, flexShrink: 0 }}
                        onClick={() => window.location.reload()}>
                        Retry
                      </button>
                    </div>
                  )}

                  {/* Manual target entry when Docker is offline */}
                  {dockerOffline && (
                    <div>
                      <label className="form-label">Add targets manually</label>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                        Format: <span className="font-mono">volume:my-volume-name</span> or <span className="font-mono">container:my-container</span>
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          id="manual-target-input"
                          className="form-input font-mono"
                          placeholder="volume:my-postgres-data"
                          style={{ flex: 1 }}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              const val = (e.target as HTMLInputElement).value.trim()
                              const [type, ...rest] = val.split(':')
                              const selector = rest.join(':').trim()
                              if (selector && (type === 'volume' || type === 'container' || type === 'image' || type === 'network')) {
                                setForm(f => ({ ...f, targets: [...f.targets, { type: type as TargetType, selector }] }))
                                ;(e.target as HTMLInputElement).value = ''
                              }
                            }
                          }}
                        />
                        <button className="btn btn-ghost" onClick={() => {
                          const input = document.getElementById('manual-target-input') as HTMLInputElement
                          if (!input) return
                          const val = input.value.trim()
                          const [type, ...rest] = val.split(':')
                          const selector = rest.join(':').trim()
                          if (selector && (type === 'volume' || type === 'container' || type === 'image' || type === 'network')) {
                            setForm(f => ({ ...f, targets: [...f.targets, { type: type as TargetType, selector }] }))
                            input.value = ''
                          }
                        }}>Add</button>
                      </div>
                      {form.targets.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                          {form.targets.map(t => (
                            <span key={`${t.type}-${t.selector}`} className="target-chip selected" style={{ cursor: 'default' }}>
                              {t.type}:{t.selector}
                              <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 4px', color: 'inherit', lineHeight: 1 }}
                                onClick={() => setForm(f => ({ ...f, targets: f.targets.filter(x => !(x.type === t.type && x.selector === t.selector)) }))}>
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Stack presets */}
                  {stacks.length > 0 && (
                    <div>
                      <label className="form-label">Compose stacks — click to add all</label>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                        {stacks.map(s => {
                          const stackTargets: TargetDraft[] = [
                            ...s.containers.map(c => ({ type: 'container' as const, selector: (c.Names?.[0] || c.Id).replace(/^\//, '') })),
                            ...s.volumes.map(v => ({ type: 'volume' as const, selector: v })),
                          ]
                          const allIn = stackTargets.length > 0 && stackTargets.every(t => isSelected(t))
                          return (
                            <button
                              key={s.project}
                              onClick={() => addStack(s)}
                              className="card card-hover"
                              style={{
                                display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
                                border: allIn ? '1px solid var(--blue-border)' : '1px solid var(--surface-4)',
                                background: allIn ? 'var(--blue-dim)' : 'var(--surface-2)',
                                cursor: 'pointer', textAlign: 'left',
                              }}
                            >
                              <Layers size={16} color={allIn ? '#60a5fa' : 'var(--text-muted)'} style={{ flexShrink: 0, marginTop: 1 }} />
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: allIn ? '#93c5fd' : 'var(--text-primary)' }}>
                                  {s.project}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                  {s.containers.length}c · {s.volumes.length}v
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Search */}
                  <div style={{ position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                    <input
                      className="form-input"
                      style={{ paddingLeft: 32 }}
                      placeholder="Filter volumes, containers, images…"
                      value={targetSearch}
                      onChange={e => setTargetSearch(e.target.value)}
                    />
                  </div>

                  {/* Target groups */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <ChipGroup
                      title="Volumes" icon={<HardDrive size={13} />}
                      items={fVols} type="volume"
                      isSelected={isSelected} toggle={toggle}
                      onSelectAll={() => selectAllType('volume', volumes)}
                      allSelected={volumes.length > 0 && volumes.every(v => isSelected({ type: 'volume', selector: v }))}
                    />
                    <ChipGroup
                      title="Containers" icon={<Box size={13} />}
                      items={fCons} type="container"
                      isSelected={isSelected} toggle={toggle}
                      onSelectAll={() => selectAllType('container', containers)}
                      allSelected={containers.length > 0 && containers.every(v => isSelected({ type: 'container', selector: v }))}
                    />
                    {fImgs.length > 0 && (
                      <ChipGroup
                        title="Images" icon={<Box size={13} />}
                        items={fImgs} type="image"
                        isSelected={isSelected} toggle={toggle}
                        onSelectAll={() => selectAllType('image', images)}
                        allSelected={images.length > 0 && images.every(v => isSelected({ type: 'image', selector: v }))}
                      />
                    )}
                    {fNets.length > 0 && (
                      <ChipGroup
                        title="Networks" icon={<NetIcon size={13} />}
                        items={fNets} type="network"
                        isSelected={isSelected} toggle={toggle}
                        onSelectAll={() => selectAllType('network', networks)}
                        allSelected={networks.length > 0 && networks.every(v => isSelected({ type: 'network', selector: v }))}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* ─── Step 2: SCHEDULE ────────────────────────── */}
              {step === 2 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {/* Left: backup schedule via CronPicker */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <CronPicker
                      label="Backup schedule"
                      value={form.schedule}
                      onChange={v => setForm(f => ({ ...f, schedule: v }))}
                    />
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px', background: 'var(--surface-1)', borderRadius: 'var(--r-sm)', fontSize: 12 }}>
                      <Info size={13} color="var(--blue-400, #60a5fa)" style={{ flexShrink: 0, marginTop: 1 }} />
                      <span style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        Backups run inside the Docker Desktop VM. Pick a window when your data is quiet —
                        typically overnight or between deployments.
                      </span>
                    </div>
                  </div>

                  {/* Right: retention + type + verify */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div>
                      <label className="form-label">Retention — how many backups to keep</label>
                      <input
                        type="number" min={1} max={365}
                        className="form-input"
                        value={form.retentionCount}
                        onChange={e => setForm(f => ({ ...f, retentionCount: parseInt(e.target.value) || 7 }))}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 11, color: 'var(--text-muted)' }}>
                        <Info size={11} />
                        Older backups are pruned automatically once the limit is reached.
                        7 is a good default for daily schedules.
                      </div>
                    </div>

                    <div>
                      <label className="form-label">Backup type</label>
                      <select
                        className="form-select"
                        value={form.backupType}
                        onChange={e => setForm(f => ({ ...f, backupType: e.target.value }))}
                      >
                        <option value="full">Full — complete snapshot every run</option>
                        <option value="incremental">Incremental — only changed files</option>
                        <option value="snapshot">Snapshot — filesystem-level snapshot</option>
                      </select>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        <strong>Full</strong> is safest and simplest. Use incremental only if backup size is a concern.
                      </div>
                    </div>

                    <div>
                      <label className="form-label">Verify schedule</label>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        <Info size={11} color="var(--emerald)" style={{ flexShrink: 0, marginTop: 1 }} />
                        Automatically scratch-restores your latest backup to confirm it is actually recoverable.
                        Highly recommended for critical data.
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {VERIFY_PRESETS.map(p => (
                          <button
                            key={p.cron}
                            onClick={() => setForm(f => ({ ...f, verifySchedule: p.cron }))}
                            className={`radio-card ${form.verifySchedule === p.cron ? 'selected' : ''}`}
                            style={{ padding: '8px 12px' }}
                          >
                            <div className="radio-dot"><div className="radio-dot-inner" /></div>
                            <div style={{ fontSize: 12, fontWeight: 600 }}>{p.label}</div>
                            {p.cron && (
                              <span className="font-mono" style={{ fontSize: 11, color: '#60a5fa', marginLeft: 'auto' }}>{p.cron}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ─── Step 3: STORAGE & REVIEW ────────────────── */}
              {step === 3 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {/* Left: storage type */}
                  <div>
                    <label className="form-label">Storage backend</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {STORAGE_TYPES.map(s => (
                        <button
                          key={s.id}
                          onClick={() => setForm(f => ({ ...f, storageType: s.id, storageConnectorId: '' }))}
                          className={`radio-card ${form.storageType === s.id ? 'selected' : ''}`}
                        >
                          <div className="radio-dot"><div className="radio-dot-inner" /></div>
                          <s.Icon size={16} color={form.storageType === s.id ? '#60a5fa' : 'var(--text-muted)'} />
                          <div style={{ textAlign: 'left' }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.desc}</div>
                          </div>
                        </button>
                      ))}
                    </div>

                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      <Info size={11} color="var(--blue-400, #60a5fa)" style={{ flexShrink: 0, marginTop: 1 }} />
                      {form.storageType === 'local'
                        ? 'Backups are stored on the Docker Desktop VM disk under /data/backups. Good for development; not recommended for sole production backups.'
                        : 'Set up a connector first in the Connectors page to store credentials securely. Then select it here.'}
                    </div>

                    {form.storageType !== 'local' && (
                      <div style={{ marginTop: 12 }}>
                        <label className="form-label">Saved connector (optional)</label>
                        <select
                          className="form-select"
                          value={form.storageConnectorId}
                          onChange={e => setForm(f => ({ ...f, storageConnectorId: e.target.value }))}
                        >
                          <option value="">— none — (will use inline config)</option>
                          {connectors.filter(c => c.type === form.storageType).map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                        {connectors.filter(c => c.type === form.storageType).length === 0 && (
                          <div style={{ fontSize: 11, color: 'var(--amber, #f59e0b)', marginTop: 4 }}>
                            No {form.storageType} connectors saved yet. Add one in the Connectors page, then come back.
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right: summary */}
                  <div>
                    <label className="form-label">Policy summary</label>
                    <div className="card" style={{ background: 'var(--surface-1)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {[
                        ['Name', form.name || '(auto-generated)'],
                        ['Targets', `${form.targets.length} selected`],
                        ['Schedule', form.schedule],
                        ['Verify',  form.verifySchedule || 'Disabled'],
                        ['Retention', `Keep ${form.retentionCount}`],
                        ['Storage', form.storageType],
                        ['Type', form.backupType],
                      ].map(([k, v]) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{k}</span>
                          <span className={k === 'Schedule' || k === 'Verify' ? 'font-mono' : ''} style={{ fontSize: 12, fontWeight: 600, textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
                        </div>
                      ))}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderTop: '1px solid var(--surface-4)', paddingTop: 10 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Active</span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={form.enabled}
                            onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                          />
                          <span style={{ fontSize: 12, fontWeight: 600, color: form.enabled ? '#34d399' : 'var(--text-muted)' }}>
                            {form.enabled ? 'Enabled' : 'Paused'}
                          </span>
                        </label>
                      </div>
                    </div>

                    {/* Targets breakdown */}
                    <div style={{ marginTop: 12 }}>
                      <label className="form-label">Selected targets</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
                        {form.targets.map(t => (
                          <span
                            key={`${t.type}-${t.selector}`}
                            className="target-chip selected"
                          >
                            {t.type === 'volume' ? '📦' : t.type === 'container' ? '🐳' : '🔗'} {t.selector}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button
            className="btn btn-ghost"
            onClick={step === 1 ? onClose : () => setStep(s => s - 1)}
          >
            <ArrowLeft size={14} />
            {step === 1 ? 'Cancel' : 'Back'}
          </button>

          {step < 3 ? (
            <button
              className="btn btn-primary"
              onClick={() => setStep(s => s + 1)}
              disabled={!canNext}
            >
              Next <ArrowRight size={14} />
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={submitting || form.targets.length === 0}
            >
              <Save size={14} />
              {submitting ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create Policy')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Chip group sub-component ───────────────────────────── */
interface ChipGroupProps {
  title: string
  icon: React.ReactNode
  items: string[]
  type: TargetType
  isSelected: (t: TargetDraft) => boolean
  toggle: (t: TargetDraft) => void
  onSelectAll: () => void
  allSelected: boolean
}

const ChipGroup: React.FC<ChipGroupProps> = ({
  title, icon, items, type, isSelected, toggle, onSelectAll, allSelected,
}) => {
  if (items.length === 0) return (
    <div className="card" style={{ background: 'var(--surface-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {icon} {title} (0)
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>None detected</div>
    </div>
  )

  return (
    <div className="card" style={{ background: 'var(--surface-1)', maxHeight: 220, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexShrink: 0 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 4 }}>
          {icon} {title} ({items.length})
        </span>
        <button
          onClick={onSelectAll}
          style={{
            marginLeft: 'auto', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3,
            color: allSelected ? '#60a5fa' : 'var(--text-muted)',
            background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0,
          }}
        >
          {allSelected ? <CheckSquare size={12} /> : <Square size={12} />}
          All
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, overflowY: 'auto', flex: 1 }}>
        {items.map(name => {
          const t: TargetDraft = { type, selector: name }
          const sel = isSelected(t)
          return (
            <button
              key={`${type}-${name}`}
              onClick={() => toggle(t)}
              className={`target-chip ${sel ? 'selected' : ''}`}
            >
              {sel && '✓ '}{name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
