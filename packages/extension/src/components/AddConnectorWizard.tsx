import React, { useState, useEffect, useRef } from 'react'
import { X, CheckCircle, AlertTriangle, Loader2, Search, Info, ChevronRight } from 'lucide-react'
import { ConnectorResource } from '@docker-rescue-kit/shared'
import { getConnectors, testConnector, saveConnectorInstance, discoverConnector } from '../api'
import { ConnectorHelp } from './ConnectorHelp'
import { InfoHint } from './InfoHint'
import { CONNECTOR_FIELD_HINTS } from '../integrationsHelp'

// Connector types where discovery is intentionally not available yet.
const DISCOVERY_NOT_AVAILABLE: string[] = ['smb', 'pbs']

// Which config field a discovered resource's name prefills, per connector type.
function prefillFieldForType(connectorType: string): string {
  switch (connectorType) {
    case 's3': return 'bucket'
    default:   return 'path'
  }
}

export const AddConnectorWizard: React.FC<{ onClose: () => void, initialType?: string }> = ({ onClose, initialType }) => {
  const [defs, setDefs] = useState<any[]>([])
  const [selectedType, setSelectedType] = useState(initialType || '')
  const [config, setConfig] = useState<Record<string, any>>({})
  const [testing, setTesting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [testResult, setTestResult] = useState<'none' | 'success' | 'failed'>('none')
  const [discovering, setDiscovering] = useState(false)
  const [discoverResults, setDiscoverResults] = useState<ConnectorResource[] | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [selectedResource, setSelectedResource] = useState<ConnectorResource | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getConnectors().then(setDefs).catch(console.error)
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
  }, [onClose, selectedType, defs.length])

  const selectedDef = defs.find(d => d.type === selectedType)
  const discoveryUnavailable = DISCOVERY_NOT_AVAILABLE.includes(selectedType)

  const handleTest = async () => {
    setTesting(true)
    setTestResult('none')
    setDiscoverResults(null)
    setDiscoverError(null)
    setSelectedResource(null)
    try {
      const res = await testConnector(selectedType, config)
      setTestResult(res.success ? 'success' : 'failed')
    } catch {
      setTestResult('failed')
    } finally {
      setTesting(false)
    }
  }

  const handleDiscover = async () => {
    if (discoveryUnavailable) return
    setDiscovering(true)
    setDiscoverResults(null)
    setDiscoverError(null)
    setSelectedResource(null)
    try {
      const res = await discoverConnector(selectedType, config)
      setDiscoverResults(res.resources || [])
    } catch (err: any) {
      setDiscoverError(err?.message || 'Scan failed. You can still save this connector and enter details manually.')
    } finally {
      setDiscovering(false)
    }
  }

  // When the user clicks a discovered resource, prefill the relevant field.
  const handleSelectResource = (r: ConnectorResource) => {
    const field = prefillFieldForType(selectedType)
    const value = field === 'bucket' ? r.name : (r.path || r.name)
    setConfig(prev => ({ ...prev, [field]: value }))
    setSelectedResource(r)
  }

  const handleSave = async () => {
    setSubmitting(true)
    try {
      await saveConnectorInstance({
        id: `${selectedType}-${Date.now()}`,
        type: selectedType as any,
        name: `${selectedDef?.displayName} - ${config.host || config.bucket || 'Primary'}`,
        config: config,
        status: testResult === 'success' ? 'online' : 'untested',
        lastTested: testResult === 'success' ? new Date() : undefined
      })
      onClose()
    } catch (err) {
      console.error('Failed to save connector', err)
      alert('Failed to save connector. Please check backend logs.')
    } finally {
      setSubmitting(false)
    }
  }

  // ENTER-to-submit when ready
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return
    if (selectedType && testResult === 'success' && !submitting) {
      e.preventDefault()
      handleSave()
    }
  }

  return (
    <div className="modal-overlay">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-connector-title"
        onKeyDown={onPanelKeyDown}
        className="modal-panel"
        style={{ maxWidth: 620 }}
      >
        <div className="modal-header">
          <h2 id="add-connector-title" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Add Storage Connector</h2>
          <button onClick={onClose} aria-label="Close" className="btn-icon">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {!selectedType ? (
            /* Step 1: pick connector type */
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {defs.map((def) => (
                <button
                  key={def.type}
                  onClick={() => { setSelectedType(def.type); setConfig({}) }}
                  className="card card-hover"
                  style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px' }}
                >
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{def.displayName}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{def.description}</span>
                </button>
              ))}
            </div>
          ) : (
            /* Step 2: configure + test + (optional) discover */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} className="animate-fade-in">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                  Configure {selectedDef?.displayName}
                </span>
                <button
                  onClick={() => { setSelectedType(''); setConfig({}); setTestResult('none'); setDiscoverResults(null); setDiscoverError(null) }}
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                >
                  Change type
                </button>
              </div>

              {/* What is this & what do I need? — collapsed by default */}
              <ConnectorHelp integrationKey={selectedType} />

              {/* Fields */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {selectedDef?.fields.map((field: any) => (
                  <div key={field.name}>
                    <label className="form-label">
                      {field.label}{field.required && <span style={{ color: 'var(--rose)', marginLeft: 2 }}>*</span>}
                      {CONNECTOR_FIELD_HINTS[field.name] && <InfoHint text={CONNECTOR_FIELD_HINTS[field.name]} />}
                    </label>
                    {field.type === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={config[field.name] ?? field.default ?? false}
                        onChange={e => setConfig({ ...config, [field.name]: e.target.checked })}
                        style={{ width: 16, height: 16 }}
                      />
                    ) : (
                      <input
                        className="form-input"
                        type={field.type === 'password' ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        value={config[field.name] ?? ''}
                        onChange={e => setConfig({ ...config, [field.name]: e.target.value })}
                      />
                    )}
                    {field.description && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>{field.description}</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Test result feedback */}
              {testResult === 'success' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                  borderRadius: 'var(--r-md)', background: 'var(--emerald-dim)',
                  border: '1px solid rgba(16,185,129,0.2)', fontSize: 13, color: '#34d399',
                }}>
                  <CheckCircle size={15} /> Connection successful — credentials look good.
                </div>
              )}
              {testResult === 'failed' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                  borderRadius: 'var(--r-md)', background: 'var(--rose-dim)',
                  border: '1px solid rgba(244,63,94,0.2)', fontSize: 13, color: '#fb7185',
                }}>
                  <AlertTriangle size={15} /> Connection failed. Double-check your host, credentials, and network access.
                </div>
              )}

              {/* Discovery section — only shown after a successful test */}
              {testResult === 'success' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Search size={13} />
                      Discover available resources
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
                    </span>
                    {!discoveryUnavailable && (
                      <button
                        onClick={handleDiscover}
                        disabled={discovering}
                        className="btn btn-ghost"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                      >
                        {discovering
                          ? <><Loader2 size={12} className="animate-spin" /> Scanning…</>
                          : <><Search size={12} /> Scan</>}
                      </button>
                    )}
                  </div>

                  {/* Discovery not available for this connector type */}
                  {discoveryUnavailable && (
                    <div style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
                      borderRadius: 'var(--r-md)', background: 'var(--surface-3)',
                      border: '1px solid var(--surface-4)', fontSize: 12, color: 'var(--text-muted)',
                    }}>
                      <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>
                        Automatic resource discovery is not available for {selectedDef?.displayName} yet — it requires elevated system privileges that the extension doesn't have at this stage. You can skip this step and enter the {selectedType === 'smb' ? 'share name' : 'datastore path'} manually above.
                      </span>
                    </div>
                  )}

                  {/* Error from discover call */}
                  {discoverError && (
                    <div style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
                      borderRadius: 'var(--r-md)', background: 'var(--amber-dim)',
                      border: '1px solid rgba(245,158,11,0.25)', fontSize: 12, color: '#fbbf24',
                    }}>
                      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>{discoverError}</span>
                    </div>
                  )}

                  {/* Discovered results — selectable */}
                  {!discoveryUnavailable && discoverResults !== null && discoverResults.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 4px' }}>
                        Click a resource to prefill the {prefillFieldForType(selectedType) === 'bucket' ? 'bucket' : 'path'} field above.
                      </p>
                      {discoverResults.map((r, i) => {
                        const isSelected = selectedResource?.id === r.id
                        return (
                          <button
                            key={i}
                            onClick={() => handleSelectResource(r)}
                            className="card card-hover"
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                              textAlign: 'left', cursor: 'pointer', fontSize: 12,
                              borderColor: isSelected ? 'var(--blue-border)' : undefined,
                              background: isSelected ? 'var(--blue-dim)' : undefined,
                            }}
                          >
                            <ChevronRight size={12} color={isSelected ? 'var(--blue-500)' : 'var(--text-muted)'} style={{ flexShrink: 0 }} />
                            <span style={{ fontWeight: 600, color: isSelected ? '#93c5fd' : 'var(--text-primary)' }}>{r.name}</span>
                            {r.type && <span className="badge badge-muted" style={{ fontSize: 10 }}>{r.type}</span>}
                            {r.path && r.path !== r.name && (
                              <span className="font-mono" style={{ color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {r.path}
                              </span>
                            )}
                            {r.size != null && r.size > 0 && (
                              <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
                                {(r.size / 1024 / 1024 / 1024).toFixed(1)} GB
                              </span>
                            )}
                            {isSelected && <CheckCircle size={13} color="var(--blue-500)" style={{ marginLeft: 'auto', flexShrink: 0 }} />}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {/* Empty results after scan */}
                  {!discoveryUnavailable && discoverResults !== null && discoverResults.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>
                      No resources found on this connector. You can still save and enter the path manually.
                    </div>
                  )}

                  {/* Prompt before any scan */}
                  {!discoveryUnavailable && discoverResults === null && !discoverError && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Scan to list available buckets, shares, or datasets — or skip and enter the path yourself.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          {selectedType && (
            <button
              onClick={handleTest}
              disabled={testing}
              className="btn btn-ghost"
            >
              {testing ? <Loader2 size={14} className="animate-spin" /> : null}
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
          )}
          {/* Skip discovery / proceed without test — always available once type is selected */}
          {selectedType && testResult !== 'success' && (
            <button
              onClick={handleSave}
              disabled={submitting}
              className="btn btn-ghost"
              title="Save without testing — connection status will show as 'untested'"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
              Save without testing
            </button>
          )}
          {testResult === 'success' && selectedType && (
            <button
              onClick={handleSave}
              disabled={submitting}
              className="btn btn-primary"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
              {submitting ? 'Saving…' : 'Save Connector'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
