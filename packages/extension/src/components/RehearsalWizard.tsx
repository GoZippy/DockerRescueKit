import React, { useState, useEffect, useRef } from 'react'
import {
  X, Save, ArrowRight, ArrowLeft, Play, Loader2, CheckCircle2,
  XCircle, AlertCircle, Clock, ShieldCheck, Info, Database,
} from 'lucide-react'
import {
  getPolicies, getPolicyHistory, startRehearsal,
} from '../api'
import { SMOKE_CHECK_TEMPLATES } from '@docker-rescue-kit/shared'

interface Props {
  onClose: () => void
  onSuccess: () => void
}

type SmokeCheckKind = 'http' | 'exec' | 'tcp' | 'file_exists' | 'sql_select_1'

const SMOKE_KIND_META: Record<SmokeCheckKind, { label: string; desc: string }> = {
  http: { label: 'HTTP probe', desc: 'GET a URL and check status code' },
  exec: { label: 'Exec command', desc: 'Run a command inside the container' },
  tcp: { label: 'TCP port', desc: 'Check a TCP port is open' },
  file_exists: { label: 'File exists', desc: 'Verify a file exists and has minimum size' },
  sql_select_1: { label: 'SQL SELECT 1', desc: 'Run SELECT 1 to verify DB connectivity' },
}

export const RehearsalWizard: React.FC<Props> = ({ onClose, onSuccess }) => {
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [streamEvents, setStreamEvents] = useState<any[]>([])
  const [streamDone, setStreamDone] = useState(false)
  const [streamOk, setStreamOk] = useState(false)

  const [policies, setPolicies] = useState<any[]>([])
  const [selectedPolicyId, setSelectedPolicyId] = useState('')
  const [backups, setBackups] = useState<any[]>([])
  const [selectedBackupIds, setSelectedBackupIds] = useState<string[]>([])

  const [smokeChecks, setSmokeChecks] = useState<any[]>([])
  const [templates] = useState(SMOKE_CHECK_TEMPLATES)

  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    document.body.classList.add('modal-open')
    return () => document.body.classList.remove('modal-open')
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const p = await getPolicies().catch(() => [])
        setPolicies(p as any[])
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
    }
  }, [])

  const loadBackups = async (policyId: string) => {
    if (!policyId) { setBackups([]); return }
    try {
      const h = await getPolicyHistory(policyId).catch(() => [])
      const success = (h as any[]).filter(b => b.status === 'success')
      setBackups(success)
      if (success.length > 0) {
        setSelectedBackupIds([success[0].id])
      }
    } catch { setBackups([]) }
  }

  const addSmokeCheck = (kind: SmokeCheckKind) => {
    const base: any = { kind, container: '' }
    if (kind === 'http') { base.port = 80; base.path = '/'; base.expectStatus = 200; base.timeoutMs = 15000 }
    if (kind === 'tcp') { base.port = 80; base.timeoutMs = 10000 }
    if (kind === 'exec') { base.command = []; base.expectExitCode = 0; base.timeoutMs = 15000 }
    if (kind === 'file_exists') { base.path = ''; base.minBytes = 1024 }
    if (kind === 'sql_select_1') { base.driver = 'postgres'; base.user = 'postgres'; base.passwordEnv = 'POSTGRES_PASSWORD'; base.timeoutMs = 15000 }
    setSmokeChecks([...smokeChecks, base])
  }

  const removeSmokeCheck = (idx: number) => {
    setSmokeChecks(smokeChecks.filter((_, i) => i !== idx))
  }

  const updateSmokeCheck = (idx: number, field: string, value: any) => {
    setSmokeChecks(smokeChecks.map((c, i) => i === idx ? { ...c, [field]: value } : c))
  }

  const applyTemplate = (templateKey: string) => {
    const tpl = templates[templateKey]
    if (tpl) setSmokeChecks([...tpl])
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    setStreamEvents([])
    setStreamDone(false)
    try {
      const payload: any = {
        smokeChecks,
        options: { stopOnFirstCheckFailure: true },
      }
      if (selectedPolicyId) {
        payload.policyId = selectedPolicyId
      } else if (selectedBackupIds.length > 0) {
        payload.backupIds = selectedBackupIds
      }

      const { startRehearsal, getRehearsalStreamUrl } = await import('../api')
      const result = await startRehearsal(payload)

      // Connect SSE stream
      const streamUrl = getRehearsalStreamUrl(result.id)
      const es = new EventSource(streamUrl)
      eventSourceRef.current = es

      es.addEventListener('hello', () => {
        setStreamEvents(prev => [...prev, { event: 'hello', data: { message: 'Connected' } }])
      })
      es.addEventListener('status', (e: any) => {
        const data = JSON.parse(e.data)
        setStreamEvents(prev => [...prev, { event: 'status', data }])
      })
      es.addEventListener('step', (e: any) => {
        const data = JSON.parse(e.data)
        setStreamEvents(prev => [...prev, { event: 'step', data }])
      })
      es.addEventListener('check', (e: any) => {
        const data = JSON.parse(e.data)
        setStreamEvents(prev => [...prev, { event: 'check', data }])
      })
      es.addEventListener('done', (e: any) => {
        const data = JSON.parse(e.data)
        setStreamDone(true)
        setStreamOk(data.ok)
        es.close()
        eventSourceRef.current = null
        setSubmitting(false)
      })
      es.onerror = () => {
        setStreamDone(true)
        setStreamOk(false)
        es.close()
        eventSourceRef.current = null
        setSubmitting(false)
      }
    } catch (err: any) {
      setSubmitting(false)
      alert(`Failed to start rehearsal: ${err?.message || 'Unknown error'}`)
    }
  }

  const STEP_LABELS = ['Backups', 'Smoke Checks', 'Run']

  return (
    <div className="modal-overlay">
      <div className="modal-panel" style={{ maxWidth: 860 }} role="dialog" aria-modal="true">

        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Restore Rehearsal</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {STEP_LABELS.map((label, i) => (
                <div key={i} style={{
                  padding: '3px 10px', borderRadius: 100, fontSize: 11, fontWeight: 600,
                  background: step === i + 1 ? 'var(--blue-dim)' : 'transparent',
                  color: step === i + 1 ? '#60a5fa' : 'var(--text-muted)',
                  border: `1px solid ${step === i + 1 ? 'var(--blue-border)' : 'transparent'}`,
                }}>
                  {i + 1}. {label}
                </div>
              ))}
            </div>
            <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div className="modal-body">
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-muted)' }}>
              Loading…
            </div>
          ) : (
            <>
              {/* Step 1: Pick backups */}
              {step === 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', background: 'var(--surface-1)', borderRadius: 'var(--r-md)', fontSize: 12, lineHeight: 1.5 }}>
                    <Info size={15} color="var(--blue-400, #60a5fa)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Pick a policy to rehearse its latest successful backup, or select specific backups.
                      The rehearsal restores them into a sandboxed network — your production containers are never touched.
                    </span>
                  </div>

                  <div>
                    <label className="form-label">Policy (optional — uses latest successful backup)</label>
                    <select
                      className="form-select"
                      value={selectedPolicyId}
                      onChange={e => {
                        setSelectedPolicyId(e.target.value)
                        setSelectedBackupIds([])
                        loadBackups(e.target.value)
                      }}
                    >
                      <option value="">— Select specific backups below —</option>
                      {policies.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>

                  {backups.length > 0 && (
                    <div>
                      <label className="form-label">Available backups</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {backups.slice(0, 10).map(b => (
                          <label key={b.id} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 10px', borderRadius: 'var(--r-sm)',
                            background: selectedBackupIds.includes(b.id) ? 'var(--blue-dim)' : 'var(--surface-1)',
                            cursor: 'pointer', fontSize: 12,
                          }}>
                            <input
                              type="checkbox"
                              checked={selectedBackupIds.includes(b.id)}
                              onChange={e => {
                                if (e.target.checked) setSelectedBackupIds([...selectedBackupIds, b.id])
                                else setSelectedBackupIds(selectedBackupIds.filter(id => id !== b.id))
                              }}
                            />
                            <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{b.id.slice(0, 8)}</span>
                            <span style={{ color: 'var(--text-muted)' }}>{new Date(b.timestamp).toLocaleString()}</span>
                            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                              {(b.size / 1024 / 1024).toFixed(1)} MB
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Step 2: Smoke checks */}
              {step === 2 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', background: 'var(--surface-1)', borderRadius: 'var(--r-md)', fontSize: 12, lineHeight: 1.5 }}>
                    <ShieldCheck size={15} color="var(--emerald)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Smoke checks run against the restored containers in the sandbox.
                      They verify your app actually works — not just that files exist.
                    </span>
                  </div>

                  {/* Templates */}
                  <div>
                    <label className="form-label">Quick templates</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6 }}>
                      {Object.keys(templates).map(key => (
                        <button key={key} className="card card-hover" style={{
                          padding: '8px 10px', cursor: 'pointer',
                          background: 'var(--surface-1)', border: '1px solid var(--surface-4)',
                          textAlign: 'left',
                        }} onClick={() => applyTemplate(key)}>
                          <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{key}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{templates[key].length} checks</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Existing checks */}
                  {smokeChecks.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <label className="form-label" style={{ marginBottom: 0 }}>Smoke checks ({smokeChecks.length})</label>
                      {smokeChecks.map((check, idx) => (
                        <div key={idx} className="card" style={{
                          background: 'var(--surface-1)', padding: '10px 12px',
                          display: 'flex', flexDirection: 'column', gap: 8,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 700 }}>
                              {SMOKE_KIND_META[check.kind as SmokeCheckKind]?.label || check.kind}
                            </span>
                            <button
                              onClick={() => removeSmokeCheck(idx)}
                              className="btn-icon" style={{ marginLeft: 'auto' }}
                              title="Remove"
                            >
                              <X size={13} color="var(--rose)" />
                            </button>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                            <div>
                              <label className="form-label">Container *</label>
                              <input
                                className="form-input"
                                placeholder="e.g. my-app"
                                value={check.container}
                                onChange={e => updateSmokeCheck(idx, 'container', e.target.value)}
                              />
                            </div>
                            {(check.kind === 'http' || check.kind === 'tcp') && (
                              <div>
                                <label className="form-label">Port *</label>
                                <input
                                  type="number" className="form-input"
                                  value={check.port}
                                  onChange={e => updateSmokeCheck(idx, 'port', parseInt(e.target.value) || 0)}
                                />
                              </div>
                            )}
                            {check.kind === 'http' && (
                              <div>
                                <label className="form-label">Path</label>
                                <input
                                  className="form-input" placeholder="/"
                                  value={check.path || ''}
                                  onChange={e => updateSmokeCheck(idx, 'path', e.target.value)}
                                />
                              </div>
                            )}
                            {check.kind === 'http' && (
                              <div>
                                <label className="form-label">Expect status</label>
                                <input
                                  type="number" className="form-input"
                                  value={check.expectStatus || 200}
                                  onChange={e => updateSmokeCheck(idx, 'expectStatus', parseInt(e.target.value) || 200)}
                                />
                              </div>
                            )}
                            {check.kind === 'exec' && (
                              <div style={{ gridColumn: '1 / -1' }}>
                                <label className="form-label">Command (comma-separated)</label>
                                <input
                                  className="form-input font-mono"
                                  placeholder="php,occ,status"
                                  value={(check.command || []).join(',')}
                                  onChange={e => updateSmokeCheck(idx, 'command', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                                />
                              </div>
                            )}
                            {check.kind === 'file_exists' && (
                              <div style={{ gridColumn: '1 / -1' }}>
                                <label className="form-label">File path *</label>
                                <input
                                  className="form-input font-mono"
                                  placeholder="/data/db.sqlite3"
                                  value={check.path || ''}
                                  onChange={e => updateSmokeCheck(idx, 'path', e.target.value)}
                                />
                              </div>
                            )}
                            {check.kind === 'sql_select_1' && (
                              <>
                                <div>
                                  <label className="form-label">Driver</label>
                                  <select
                                    className="form-select"
                                    value={check.driver || 'postgres'}
                                    onChange={e => updateSmokeCheck(idx, 'driver', e.target.value)}
                                  >
                                    <option value="postgres">PostgreSQL</option>
                                    <option value="mysql">MySQL</option>
                                    <option value="mssql">MS SQL</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="form-label">Database</label>
                                  <input
                                    className="form-input" placeholder="mydb"
                                    value={check.db || ''}
                                    onChange={e => updateSmokeCheck(idx, 'db', e.target.value)}
                                  />
                                </div>
                                <div>
                                  <label className="form-label">User</label>
                                  <input
                                    className="form-input" placeholder="postgres"
                                    value={check.user || ''}
                                    onChange={e => updateSmokeCheck(idx, 'user', e.target.value)}
                                  />
                                </div>
                                <div>
                                  <label className="form-label">Password env var</label>
                                  <input
                                    className="form-input" placeholder="POSTGRES_PASSWORD"
                                    value={check.passwordEnv || ''}
                                    onChange={e => updateSmokeCheck(idx, 'passwordEnv', e.target.value)}
                                  />
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add check buttons */}
                  <div>
                    <label className="form-label">Add a smoke check</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {(Object.keys(SMOKE_KIND_META) as SmokeCheckKind[]).map(kind => (
                        <button key={kind} className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => addSmokeCheck(kind)}>
                          + {SMOKE_KIND_META[kind].label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Step 3: Run */}
              {step === 3 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {!submitting && !streamDone && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', background: 'var(--surface-1)', borderRadius: 'var(--r-md)', fontSize: 12, lineHeight: 1.5 }}>
                        <Play size={15} color="var(--blue-400, #60a5fa)" style={{ flexShrink: 0, marginTop: 1 }} />
                        <span style={{ color: 'var(--text-secondary)' }}>
                          Ready to run. This will create a sandboxed network, restore backups, launch containers, and run {smokeChecks.length} smoke check(s).
                        </span>
                      </div>
                      <div className="card" style={{ background: 'var(--surface-1)' }}>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Summary</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12 }}>
                          <span style={{ color: 'var(--text-muted)' }}>Target</span>
                          <span style={{ fontWeight: 600 }}>
                            {selectedPolicyId
                              ? policies.find(p => p.id === selectedPolicyId)?.name || 'Unknown policy'
                              : `${selectedBackupIds.length} backup(s)`}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>Smoke checks</span>
                          <span style={{ fontWeight: 600 }}>{smokeChecks.length}</span>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Stream output */}
                  {(submitting || streamDone) && (
                    <div>
                      <label className="form-label" style={{ marginBottom: 6 }}>
                        {streamDone
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              {streamOk
                                ? <><CheckCircle2 size={13} color="var(--emerald)" /> Rehearsal passed</>
                                : <><XCircle size={13} color="var(--rose)" /> Rehearsal failed</>
                              }
                            </span>
                          : <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <Loader2 size={13} className="animate-spin" /> Running…
                            </span>
                        }
                      </label>
                      <div style={{
                        background: 'var(--surface-1)', borderRadius: 'var(--r-sm)',
                        padding: '8px 12px', maxHeight: 300, overflowY: 'auto',
                        fontFamily: 'monospace', fontSize: 11,
                      }}>
                        {streamEvents.map((ev, i) => (
                          <div key={i} style={{
                            padding: '2px 0',
                            color: ev.event === 'check' && ev.data.ok === false ? 'var(--rose)'
                              : ev.event === 'step' && ev.data.ok === false ? 'var(--rose)'
                              : ev.event === 'check' && ev.data.ok === true ? 'var(--emerald)'
                              : 'var(--text-secondary)',
                          }}>
                            [{ev.event}]
                            {ev.event === 'status' && ` ${ev.data.status}`}
                            {ev.event === 'step' && ` ${ev.data.label}${ev.data.ok ? ' ✓' : ' ✗'}${ev.data.detail ? ' — ' + ev.data.detail : ''}`}
                            {ev.event === 'check' && ` ${ev.data.check.kind}:${ev.data.check.container} ${ev.data.ok ? '✓' : '✗'}${ev.data.detail ? ' — ' + ev.data.detail : ''}`}
                          </div>
                        ))}
                        {submitting && (
                          <div style={{ color: 'var(--text-muted)', padding: '4px 0' }}>
                            <Loader2 size={10} className="animate-spin" style={{ display: 'inline', marginRight: 4 }} />
                            Waiting for events…
                          </div>
                        )}
                      </div>
                    </div>
                  )}
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
            disabled={submitting}
          >
            <ArrowLeft size={14} />
            {step === 1 ? 'Cancel' : 'Back'}
          </button>

          {step < 3 ? (
            <button
              className="btn btn-primary"
              onClick={() => setStep(s => s + 1)}
              disabled={
                (step === 1 && !selectedPolicyId && selectedBackupIds.length === 0) ||
                (step === 2 && smokeChecks.length === 0)
              }
            >
              Next <ArrowRight size={14} />
            </button>
          ) : (
            !streamDone && (
              <button
                className="btn btn-primary"
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? <><Loader2 size={14} className="animate-spin" /> Running…</> : <><Play size={14} /> Run rehearsal</>}
              </button>
            )
          )}

          {streamDone && (
            <button className="btn btn-ghost" onClick={onSuccess}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}