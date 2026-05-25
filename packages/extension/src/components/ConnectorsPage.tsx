import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { Server, Database, Cloud, Plus, Loader2 } from 'lucide-react'
import { getConnectors } from '../api'

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

export const ConnectorsPage: React.FC = () => {
  const [definitions, setDefinitions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [errorKind, setErrorKind] = useState<PageErrorKind | null>(null)
  const [showWizard, setShowWizard] = useState<boolean | string>(false)
  const [showRclone, setShowRclone] = useState(false)
  const toast = useToast()

  const loadData = async () => {
    setErrorKind(null)
    try {
      const defs = await getConnectors()
      setDefinitions(defs)
    } catch (e) {
      console.error('Failed to load connector definitions', e)
      setErrorKind(errorKindFromAxios(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const handleWizardClose = (saved?: boolean) => {
    setShowWizard(false)
    if (saved) {
      toast.push('success', 'Credential saved — view it in Storage Vault')
    }
  }

  if (errorKind) {
    return (
      <PageError
        kind={errorKind}
        title={errorKind === 'unknown' ? 'Failed to load integrations' : undefined}
        onRetry={() => { setLoading(true); loadData() }}
      />
    )
  }

  return (
    <div className="space-y-8">
      {showWizard !== false && (
        <AddConnectorWizard
          onClose={() => handleWizardClose()}
          initialType={typeof showWizard === 'string' ? showWizard : undefined}
        />
      )}
      {showRclone && <RcloneWizard onClose={() => setShowRclone(false)} />}

      <div>
        <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2 mb-1">
          <Plus className="text-blue-400" /> Available Integrations
        </h2>
        <p className="text-sm text-slate-400">
          Set up new storage backends. Credentials are encrypted at rest with AES-256-GCM and managed under Storage Vault.
        </p>
      </div>

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

      {/* Marketplace */}
      <section>
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
