import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { Server, Database, Cloud, Plus, Check, Loader2, X, RefreshCw } from 'lucide-react'
import { getConnectors, getConnectorInstances, deleteConnectorInstance } from '../api'

import { AddConnectorWizard } from './AddConnectorWizard'
import { RcloneWizard } from './RcloneWizard'
import { PageError, PageErrorKind } from './PageError'
import { useToast } from '../hooks/useToast'

const errorKindFromAxios = (e: unknown): PageErrorKind => {
  if (axios.isAxiosError(e)) {
    if (e.response?.status === 401) return 'auth'
    if (e.response?.status === 503) return 'docker-offline'
  }
  return 'unknown'
}

const errorMessage = (e: unknown): string => {
  if (axios.isAxiosError(e)) {
    return (e.response?.data as any)?.error || e.message || 'Request failed'
  }
  if (e instanceof Error) return e.message
  return 'Unknown error'
}

export const ConnectorsPage: React.FC = () => {
  const [definitions, setDefinitions] = useState<any[]>([])
  const [instances, setInstances] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [errorKind, setErrorKind] = useState<PageErrorKind | null>(null)
  const [showWizard, setShowWizard] = useState<boolean | string>(false)
  const [showRclone, setShowRclone] = useState(false)
  const toast = useToast()

  const loadData = async () => {
    setErrorKind(null)
    try {
      const [defs, insts] = await Promise.all([
        getConnectors(),
        getConnectorInstances()
      ])
      setDefinitions(defs)
      setInstances(insts)
    } catch (e) {
      console.error('Failed to load connectors', e)
      setErrorKind(errorKindFromAxios(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this connector instance?')) return
    try {
      await deleteConnectorInstance(id)
      toast.push('success', 'Connector deleted')
      loadData()
    } catch (e) {
      toast.push('error', `Failed to delete connector: ${errorMessage(e)}`)
    }
  }

  // Wizard close handler — emit a save toast when the wizard reports success.
  // The AddConnectorWizard owns its own form-level test/discover/save errors;
  // we surface a friendly outcome toast when the modal closes after activity.
  const handleWizardClose = (saved?: boolean) => {
    setShowWizard(false)
    if (saved) {
      toast.push('success', 'Connector saved')
    }
    loadData()
  }

  if (errorKind) {
    return (
      <PageError
        kind={errorKind}
        title={errorKind === 'unknown' ? 'Failed to load connectors' : undefined}
        onRetry={() => { setLoading(true); loadData() }}
      />
    )
  }

  return (
    <div className="space-y-12">
      {showWizard !== false && (
        <AddConnectorWizard
          onClose={() => handleWizardClose()}
          initialType={typeof showWizard === 'string' ? showWizard : undefined}
        />
      )}
      {showRclone && <RcloneWizard onClose={() => setShowRclone(false)} />}

      {/* Rclone quick-access banner */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 20px' }}>
        <Cloud size={22} color="var(--blue-500)" style={{ flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Rclone cloud remotes</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Configure Google Drive, OneDrive, Dropbox, Backblaze B2, WebDAV, S3 and more. Used by the Rclone storage adapter.
          </div>
        </div>
        <button className="btn btn-primary" style={{ flexShrink: 0 }} onClick={() => setShowRclone(true)}>
          <Cloud size={14} /> Manage remotes
        </button>
      </div>

      {/* Active Instances Section */}
      <section>
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
              <Check className="text-emerald-400" /> Active Connections
            </h2>
            <p className="text-sm text-slate-400 mt-1">Configured hardware and cloud endpoints currently available for operations.</p>
          </div>
        </div>

        {instances.length === 0 ? (
          <div className="p-8 text-center border-2 border-dashed border-slate-800 rounded-2xl bg-slate-900/50">
            <p className="text-slate-500">No connectors configured. Add one below to start discovery.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
             {instances.map(inst => (
               <div key={inst.id} className="glass-card p-6 flex flex-col border-emerald-500/20 group">
                 <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-bold text-slate-100">{inst.name}</h3>
                      <span className="text-xs font-mono text-emerald-400 uppercase tracking-widest">{inst.type}</span>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => handleDelete(inst.id)} className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors">
                        <X size={16} />
                      </button>
                    </div>
                 </div>
                 
                 <div className="flex-1 space-y-3">
                    <div className="flex items-center gap-2 text-sm text-slate-400">
                      <div className={`w-2 h-2 rounded-full ${inst.status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                      {inst.status === 'online' ? 'Connection Healthy' : 'Connection Failed'}
                    </div>
                 </div>

                 <div className="mt-6 flex gap-2">
                   <button className="flex-1 text-sm font-medium py-2 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white transition-all">Manage Resources</button>
                   <button onClick={() => setShowWizard(inst.type)} className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors">
                      <RefreshCw size={18} />
                   </button>
                 </div>
               </div>
             ))}
          </div>
        )}
      </section>

      {/* Marketplace / Definitions Section */}
      <section>
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
              <Plus className="text-blue-400" /> Available Integrations
            </h2>
            <p className="text-sm text-slate-400 mt-1">Install new plugins and expand your infrastructure access.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {loading ? (
               <div className="col-span-full flex justify-center py-12"><Loader2 className="animate-spin text-slate-500" /></div>
          ) : definitions.map(conn => (
            <div key={conn.type} className="glass-card p-6 flex flex-col group relative overflow-hidden">
              <div className="absolute -right-10 -top-10 text-slate-100/5 rotate-12 transition-transform group-hover:rotate-6 group-hover:scale-110">
                {conn.icon === 'server' && <Server size={140} />}
                {conn.icon === 'database' && <Database size={140} />}
              </div>
              <div className="relative z-10">
                <h3 className="text-lg font-bold text-slate-200 mb-2">{conn.displayName}</h3>
                <p className="text-sm text-slate-400 mb-6 flex-1 min-h-[3rem]">{conn.description}</p>
                
                <div className="mt-auto flex items-center justify-between border-t border-slate-700/50 pt-4">
                  <span className="text-xs text-slate-500 font-mono bg-slate-900/50 px-2 py-1 rounded">id: {conn.type}</span>
                  <button onClick={() => setShowWizard(conn.type)} className="text-blue-400 text-sm font-medium hover:text-blue-300 flex items-center gap-1 group/btn">
                    Set Up <Plus size={14} className="group-hover/btn:translate-x-0.5 transition-transform" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

