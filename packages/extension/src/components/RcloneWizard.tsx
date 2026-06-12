import React, { useState, useEffect, useRef } from 'react'
import {
  X, Cloud, Server, HardDrive, Wifi, CheckCircle2, AlertCircle,
  ExternalLink, Copy, RefreshCw, Loader2, Trash2, Plus, Terminal, ShieldCheck, Download
} from 'lucide-react'
import {
  getRcloneProviders, getRcloneRemotes, checkRclone,
  createRcloneRemote, deleteRcloneRemote, testRcloneRemote,
  startRcloneOAuth, finishRcloneOAuth
} from '../api'
import { HelpDisclosure } from './HelpDisclosure'
import { ConnectorHelp } from './ConnectorHelp'
import { RcloneInstallHelper } from './RcloneInstallHelper'
import { InfoHint } from './InfoHint'
import { FaqAccordion } from './FaqAccordion'
import { RCLONE_OVERVIEW_HELP, RCLONE_FAQS, FIELD_HINTS } from '../integrationsHelp'

interface Provider {
  id: string; name: string; description: string
  authType: 'oauth' | 'key' | 'none'; icon: string
  fields: Array<{ name: string; label: string; type: string; required: boolean; placeholder?: string; description?: string }>
}

interface Remote { name: string; type: string; configured: boolean }

const ICONS: Record<string, React.FC<any>> = {
  gdrive: Cloud, onedrive: Cloud, dropbox: Cloud,
  b2: Cloud, s3: Cloud, webdav: Server, sftp: Wifi, local: HardDrive,
}

interface Props {
  onClose: () => void
}

export const RcloneWizard: React.FC<Props> = ({ onClose }) => {
  const [view, setView] = useState<'remotes' | 'add'>('remotes')
  const [providers, setProviders] = useState<Provider[]>([])
  const [remotes, setRemotes] = useState<Remote[]>([])
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({})
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Rclone available check + version (for the "ready" badge)
  const [rcloneOk, setRcloneOk] = useState<boolean | null>(null)
  const [rcloneVersion, setRcloneVersion] = useState<string | null>(null)

  // Key-based form
  const [remoteName, setRemoteName] = useState('')
  const [keyParams, setKeyParams] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // OAuth state
  const [oauthStep, setOauthStep] = useState<'idle' | 'fetching' | 'paste' | 'done'>('idle')
  const [savingOAuth, setSavingOAuth] = useState(false)
  const [oauthCommand, setOauthCommand] = useState<string | null>(null)
  const [oauthToken, setOauthToken] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.body.classList.add('modal-open')
    return () => {
      document.body.classList.remove('modal-open')
    }
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
  }, [onClose, view, selectedProvider, oauthStep])

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      // checkRclone is the authoritative "is rclone present" signal — the
      // providers list is a static catalogue and won't fail when rclone is
      // missing, so we can't infer availability from it.
      const [p, r, chk] = await Promise.all([
        getRcloneProviders(),
        getRcloneRemotes().catch(() => []),
        checkRclone().catch(() => ({ installed: true, version: null, configPath: '' })),
      ])
      setProviders(p)
      setRemotes(r)
      setRcloneOk(chk.installed)
      setRcloneVersion(chk.version)
    } catch (e: any) {
      if (e?.response?.data?.error?.includes('rclone')) {
        setRcloneOk(false)
      }
      setError(e?.response?.data?.error || e.message)
    } finally {
      setLoading(false)
    }
  }

  const testRemote = async (name: string) => {
    setTesting(name)
    try {
      const result = await testRcloneRemote(name)
      setTestResults(p => ({ ...p, [name]: result }))
    } finally {
      setTesting(null)
    }
  }

  const deleteRemote = async (name: string) => {
    if (!confirm(`Delete remote "${name}"? This only removes the rclone config — no data is deleted.`)) return
    await deleteRcloneRemote(name)
    setRemotes(rs => rs.filter(r => r.name !== name))
    setTestResults(p => { const n = { ...p }; delete n[name]; return n })
  }

  const startAdd = (provider: Provider) => {
    setSelectedProvider(provider)
    setRemoteName('')
    setKeyParams({})
    setOauthStep('idle')
    setOauthCommand(null)
    setOauthToken('')
    setView('add')
  }

  const cancelAdd = () => {
    setView('remotes')
    setSelectedProvider(null)
    setOauthStep('idle')
  }

  // ── Key-based save ────────────────────────────────────────────────────

  const saveKeyRemote = async () => {
    if (!remoteName.trim() || !selectedProvider) return
    setSaving(true)
    setError(null)
    try {
      await createRcloneRemote(remoteName.trim(), selectedProvider.id, keyParams)
      await load()
      setView('remotes')
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message)
    } finally {
      setSaving(false)
    }
  }

  // ── OAuth flow ─────────────────────────────────────────────────────────

  const beginOAuth = async () => {
    if (!remoteName.trim() || !selectedProvider) return
    setOauthStep('fetching')
    setOauthCommand(null)
    setError(null)
    try {
      const { command } = await startRcloneOAuth(selectedProvider.id)
      setOauthCommand(command)
      setOauthStep('paste')
    } catch (e: any) {
      setOauthStep('idle')
      setError(e?.response?.data?.error || e.message)
    }
  }

  const finishOAuth = async () => {
    if (!oauthToken.trim() || !remoteName.trim() || !selectedProvider) return
    setSavingOAuth(true)
    setError(null)
    try {
      await finishRcloneOAuth(remoteName.trim(), selectedProvider.id, oauthToken.trim())
      setOauthStep('done')
      await load()
      setTimeout(() => setView('remotes'), 1500)
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message)
    } finally {
      setSavingOAuth(false)
    }
  }

  const copyCommand = () => { if (oauthCommand) navigator.clipboard.writeText(oauthCommand) }

  // ── Render ─────────────────────────────────────────────────────────────

  // ENTER-to-submit on add view (key auth) or to authorize/save token on oauth
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return
    if (view !== 'add' || !selectedProvider) return
    if (selectedProvider.authType === 'key' && remoteName.trim() && !saving) {
      e.preventDefault()
      saveKeyRemote()
    } else if (selectedProvider.authType === 'oauth' && oauthStep === 'idle' && remoteName.trim()) {
      e.preventDefault()
      beginOAuth()
    } else if (selectedProvider.authType === 'oauth' && oauthStep === 'paste' && oauthToken.trim() && !savingOAuth) {
      e.preventDefault()
      finishOAuth()
    }
  }

  return (
    <div className="modal-overlay">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rclone-wizard-title"
        onKeyDown={onPanelKeyDown}
        className="modal-panel"
        style={{ maxWidth: 780 }}
      >

        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span id="rclone-wizard-title" style={{ fontWeight: 700, fontSize: 15 }}>
              {view === 'remotes' ? 'Rclone Remotes' : `Add Remote — ${selectedProvider?.name}`}
            </span>
            {rcloneOk === true && (
              <span
                className="badge badge-success"
                style={{ fontSize: 10 }}
                title="DRK ships rclone for transfers — it's already working. You only need rclone on your own computer for cloud sign-in."
              >
                <ShieldCheck size={11} /> rclone{rcloneVersion ? ` ${rcloneVersion}` : ''} ready
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {view === 'add' && (
              <button className="btn btn-ghost" onClick={cancelAdd}>← Back</button>
            )}
            <button className="btn-icon" onClick={onClose} aria-label="Close wizard"><X size={18} /></button>
          </div>
        </div>

        <div className="modal-body">

          {/* Rclone not installed (rare — DRK normally bundles it; this shows
              only if RCLONE_BIN is misconfigured or the binary is missing) */}
          {rcloneOk === false && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4, color: 'var(--rose)' }}>
                  rclone wasn't found on the DRK host
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                  DRK usually ships rclone inside its container, so this is unusual — it can happen if{' '}
                  <span className="font-mono">RCLONE_BIN</span> points somewhere wrong. Install it on the
                  machine running DRK, then re-check.
                </p>
              </div>
              <ConnectorHelp
                help={RCLONE_OVERVIEW_HELP}
                title="What is rclone & why does DRK use it?"
              />
              <div className="card">
                <RcloneInstallHelper context="backend" />
              </div>
              <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={load}>
                <RefreshCw size={14} /> Check again
              </button>
            </div>
          )}

          {rcloneOk !== false && view === 'remotes' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Newcomer-friendly explainer — collapsed so it never crowds the UI */}
              <ConnectorHelp
                help={RCLONE_OVERVIEW_HELP}
                title="New to rclone? What it is & whether you need to install anything"
              />

              {/* Existing remotes */}
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', padding: 24, justifyContent: 'center' }}>
                  <Loader2 size={16} className="animate-spin" /> Loading remotes…
                </div>
              ) : remotes.length === 0 ? (
                <div className="empty-state card">No rclone remotes configured yet. Add one below.</div>
              ) : (
                <div className="card" style={{ padding: 0 }}>
                  {remotes.map((r, i) => {
                    const result = testResults[r.name]
                    return (
                      <div key={r.name} style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                        borderBottom: i < remotes.length - 1 ? '1px solid var(--surface-4)' : undefined,
                      }}>
                        <Cloud size={18} color="var(--blue-500)" />
                        <div style={{ flex: 1 }}>
                          <div className="font-mono" style={{ fontWeight: 600, fontSize: 13 }}>{r.name}:</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.type}</div>
                        </div>
                        {result && (
                          result.ok
                            ? <span className="badge badge-success"><CheckCircle2 size={11} /> OK</span>
                            : <span className="badge badge-danger" title={result.error}><AlertCircle size={11} /> Failed</span>
                        )}
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 12 }}
                          disabled={testing === r.name}
                          onClick={() => testRemote(r.name)}
                        >
                          {testing === r.name ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          Test
                        </button>
                        <button className="btn-icon" onClick={() => deleteRemote(r.name)} title="Delete remote">
                          <Trash2 size={15} color="var(--rose)" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Provider grid */}
              <div>
                <div className="form-label">Add a new remote</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
                  {providers.map(p => {
                    const Icon = ICONS[p.icon] || Cloud
                    return (
                      <button
                        key={p.id}
                        className="card card-hover"
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 10px', cursor: 'pointer', textAlign: 'center' }}
                        onClick={() => startAdd(p)}
                      >
                        <Icon size={22} color="var(--blue-500)" />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 12 }}>{p.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{p.description}</div>
                        </div>
                        {p.authType === 'oauth' && (
                          <span className="badge badge-info" style={{ fontSize: 10 }}>OAuth</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Questions & safety FAQ — collapsed by default */}
              <HelpDisclosure
                icon={<ShieldCheck size={14} />}
                title="Questions about rclone? Safety, privacy & troubleshooting"
              >
                <FaqAccordion items={RCLONE_FAQS} />
              </HelpDisclosure>
            </div>
          )}

          {/* Add remote form */}
          {rcloneOk !== false && view === 'add' && selectedProvider && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {error && (
                <div style={{ padding: '10px 14px', background: 'var(--rose-dim)', border: '1px solid rgba(244,63,94,0.3)', borderRadius: 'var(--r-md)', fontSize: 13, color: '#fda4af' }}>
                  {error}
                </div>
              )}

              {/* Per-provider context — what it's for and what you'll need */}
              <ConnectorHelp integrationKey={selectedProvider.id} defaultOpen />

              <div>
                <label className="form-label">Remote name</label>
                <input
                  className="form-input font-mono"
                  placeholder={`my-${selectedProvider.id}`}
                  value={remoteName}
                  onChange={e => setRemoteName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '-'))}
                  autoFocus
                />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Used as the rclone remote prefix: <span className="font-mono">{remoteName || 'my-remote'}:</span>
                </div>
              </div>

              {/* Key-based fields */}
              {selectedProvider.authType === 'key' && selectedProvider.fields.map(f => (
                <div key={f.name}>
                  <label className="form-label">
                    {f.label}{f.required ? '' : ' (optional)'}
                    {FIELD_HINTS[f.name] && <InfoHint text={FIELD_HINTS[f.name]} />}
                  </label>
                  {f.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{f.description}</div>}
                  <input
                    className={`form-input${f.type === 'password' ? '' : ' font-mono'}`}
                    type={f.type === 'password' ? 'password' : 'text'}
                    placeholder={f.placeholder || ''}
                    value={keyParams[f.name] || ''}
                    onChange={e => setKeyParams(p => ({ ...p, [f.name]: e.target.value }))}
                  />
                </div>
              ))}

              {/* OAuth flow */}
              {selectedProvider.authType === 'oauth' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {oauthStep === 'idle' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div className="card" style={{ background: 'var(--surface-1)' }}>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                          {selectedProvider.name} uses a browser sign-in that must run on a machine
                          with a web browser (your own desktop). Click <strong>Authorize</strong> and
                          we'll give you a one-line <span className="font-mono">rclone authorize</span>{' '}
                          command to run there — then paste the token it prints back here.
                        </p>
                      </div>
                      <HelpDisclosure
                        compact
                        icon={<Download size={13} />}
                        title="Don't have rclone on that computer yet? Install it"
                      >
                        <RcloneInstallHelper context="host" />
                      </HelpDisclosure>
                    </div>
                  )}

                  {oauthStep === 'fetching' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 16, background: 'var(--surface-1)', borderRadius: 'var(--r-md)' }}>
                      <Loader2 size={16} className="animate-spin" color="var(--blue-500)" />
                      <span style={{ fontSize: 13 }}>Preparing authorize command…</span>
                    </div>
                  )}

                  {oauthStep === 'paste' && oauthCommand && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div className="card" style={{ background: 'var(--blue-dim)', border: '1px solid var(--blue-border)' }}>
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, color: '#93c5fd' }}>
                          Step 1 — Run this on a machine with a browser
                        </div>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0, marginBottom: 8 }}>
                          Requires rclone installed there (<span className="font-mono">rclone.org/downloads</span>).
                          It opens a browser tab — sign in and approve. rclone then prints a token.
                        </p>
                        <div className="font-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, background: 'var(--surface-1)', padding: '8px 10px', borderRadius: 'var(--r-sm)' }}>
                          <Terminal size={13} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                          <span style={{ flex: 1, wordBreak: 'break-all' }}>{oauthCommand}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={copyCommand}>
                            <Copy size={12} /> Copy command
                          </button>
                        </div>
                      </div>

                      <HelpDisclosure
                        compact
                        icon={<Download size={13} />}
                        title="That command says rclone isn't installed there? Install it"
                      >
                        <RcloneInstallHelper context="host" />
                      </HelpDisclosure>

                      <div>
                        <label className="form-label">
                          Step 2 — Paste the token rclone printed
                          <InfoHint text={FIELD_HINTS.token} />
                        </label>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                          Copy everything between <span className="font-mono">{'--->'}</span> and{' '}
                          <span className="font-mono">{'<---End paste'}</span> — a JSON object starting
                          with <span className="font-mono">{`{"access_token":`}</span>.
                        </p>
                        <textarea
                          className="form-input font-mono"
                          rows={4}
                          placeholder={`{"access_token":"..."}`}
                          value={oauthToken}
                          onChange={e => setOauthToken(e.target.value)}
                          style={{ resize: 'vertical' }}
                        />
                      </div>
                    </div>
                  )}

                  {oauthStep === 'done' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--emerald)', fontSize: 14, fontWeight: 700, padding: 16 }}>
                      <CheckCircle2 size={20} /> Remote "{remoteName}" saved successfully!
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {view === 'add' && selectedProvider && oauthStep !== 'done' && (
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={cancelAdd}>Cancel</button>
            <div style={{ display: 'flex', gap: 8 }}>
              {selectedProvider.authType === 'key' && (
                <button
                  className="btn btn-primary"
                  disabled={!remoteName.trim() || saving}
                  onClick={saveKeyRemote}
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {saving ? 'Saving…' : 'Add remote'}
                </button>
              )}
              {selectedProvider.authType === 'oauth' && oauthStep === 'idle' && (
                <button
                  className="btn btn-primary"
                  disabled={!remoteName.trim()}
                  onClick={beginOAuth}
                >
                  <ExternalLink size={14} /> Authorize with {selectedProvider.name}
                </button>
              )}
              {selectedProvider.authType === 'oauth' && oauthStep === 'paste' && (
                <button
                  className="btn btn-primary"
                  disabled={!oauthToken.trim() || savingOAuth}
                  onClick={finishOAuth}
                >
                  {savingOAuth ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {savingOAuth ? 'Saving…' : 'Save token'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
