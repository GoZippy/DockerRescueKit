import React, { useState, useEffect, useRef } from 'react'
import { X, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { getConnectors, testConnector, saveConnectorInstance } from '../api'

export const AddConnectorWizard: React.FC<{ onClose: () => void, initialType?: string }> = ({ onClose, initialType }) => {
  const [defs, setDefs] = useState<any[]>([])
  const [selectedType, setSelectedType] = useState(initialType || '')
  const [config, setConfig] = useState<Record<string, any>>({})
  const [testing, setTesting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [testResult, setTestResult] = useState<'none' | 'success' | 'failed'>('none')
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

  const handleTest = async () => {
    setTesting(true)
    setTestResult('none')
    try {
      const res = await testConnector(selectedType, config)
      setTestResult(res.success ? 'success' : 'failed')
    } catch {
      setTestResult('failed')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSubmitting(true)
    try {
      await saveConnectorInstance({
        id: `${selectedType}-${Date.now()}`,
        type: selectedType as any,
        name: `${selectedDef?.displayName} - ${config.host || 'Primary'}`,
        config: config,
        status: testResult === 'success' ? 'online' : 'untested',
        lastTested: testResult === 'success' ? new Date() : undefined
      })
      onClose()
    } catch (err) {
      console.error('Failed to save connector', err)
      alert('Failed to persist connector. Please check backend logs.')
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
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="flex min-h-full items-start sm:items-center justify-center p-4 sm:p-6 py-10">
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-connector-title"
          onKeyDown={onPanelKeyDown}
          className="glass-card w-full max-w-2xl bg-[#020617] border-slate-700/50 flex flex-col relative"
        >
          <div className="flex justify-between items-center p-6 border-b border-slate-700/50 shrink-0">
            <h2 id="add-connector-title" className="text-xl font-bold flex items-center gap-2">Add Storage Connector</h2>
            <button onClick={onClose} aria-label="Close" className="p-2 hover:bg-slate-800 rounded-lg text-slate-400">
              <X size={20} />
            </button>
          </div>

          <div className="p-6 flex-1 space-y-6">
            {!selectedType ? (
              <div className="grid grid-cols-2 gap-4">
                {defs.map((def) => (
                  <button
                    key={def.type}
                    onClick={() => setSelectedType(def.type)}
                    className="p-4 rounded-xl border border-slate-700/50 bg-slate-800/30 hover:border-blue-500/50 hover:bg-blue-500/10 text-left transition-colors"
                  >
                    <h3 className="font-bold text-slate-200">{def.displayName}</h3>
                    <p className="text-xs text-slate-400 mt-1">{def.description}</p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-6 animate-fade-in">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-slate-200">Configure {selectedDef?.displayName}</h3>
                  <button onClick={() => setSelectedType('')} className="text-sm text-blue-400 hover:text-blue-300">Change Type</button>
                </div>
                
                <div className="space-y-4">
                  {selectedDef?.fields.map((field: any) => (
                    <div key={field.name}>
                      <label className="block text-sm font-medium text-slate-400 mb-1">{field.label}</label>
                      {field.type === 'boolean' ? (
                        <input 
                          type="checkbox" 
                          checked={config[field.name] || field.default} 
                          onChange={e => setConfig({...config, [field.name]: e.target.checked})}
                          className="w-4 h-4 rounded border-slate-700 bg-slate-800/50 text-blue-500"
                        />
                      ) : (
                        <input
                          type={field.type}
                          placeholder={field.placeholder}
                          value={config[field.name] || ''}
                          onChange={e => setConfig({...config, [field.name]: e.target.value})}
                          className="w-full bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-slate-100 placeholder-slate-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all font-mono text-sm"
                        />
                      )}
                      {field.description && <p className="text-xs text-slate-500 mt-1">{field.description}</p>}
                    </div>
                  ))}
                </div>

                {testResult === 'success' && (
                  <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex items-center gap-2 text-emerald-400 text-sm">
                    <CheckCircle size={16} /> Connection successful!
                  </div>
                )}
                {testResult === 'failed' && (
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-red-400 text-sm">
                    <AlertTriangle size={16} /> Connection failed. Please check credentials.
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="p-6 border-t border-slate-700/50 flex justify-end gap-3 bg-slate-900/50 rounded-b-xl">
            <button onClick={onClose} className="px-4 py-2 rounded-lg font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors">
              Cancel
            </button>
            {selectedType && (
              <button 
                onClick={handleTest} 
                disabled={testing}
                className="px-4 py-2 rounded-lg font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors flex items-center gap-2"
              >
                {testing ? <Loader2 size={16} className="animate-spin" /> : null} Test Connection
              </button>
            )}
            {testResult === 'success' && selectedType && (
              <button 
                onClick={handleSave} 
                disabled={submitting}
                className="glow-btn px-6 py-2 flex items-center gap-2"
              >
                {submitting && <Loader2 size={16} className="animate-spin" />}
                Save Connector
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
