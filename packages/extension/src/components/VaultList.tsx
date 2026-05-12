import React, { useEffect, useState } from 'react'
import { Server, Database, Shield, Lock, ShieldAlert, Loader2 } from 'lucide-react'
import { getPolicies } from '../api'

export const VaultList: React.FC = () => {
  const [storages, setStorages] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchStorages = async () => {
      try {
        const policies = await getPolicies()
        // Deduplicate storage configurations by id or path
        const uniqueStorages = Array.from(new Map(policies.map(p => [(p.storage as any).id || p.storage.path, p.storage])).values())
        setStorages(uniqueStorages)
      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }
    }
    fetchStorages()
  }, [])

  return (
    <div className="space-y-6 animate-fade-in">
      
      {/* Vault Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-card p-6 flex flex-col gap-2">
          <div className="flex justify-between items-center text-slate-400">
            <span className="font-bold">Total Secrets</span>
            <Shield size={20} className="text-blue-400" />
          </div>
          <span className="text-3xl font-bold">{loading ? '-' : storages.length}</span>
        </div>
        <div className="glass-card p-6 flex flex-col gap-2">
          <div className="flex justify-between items-center text-slate-400">
            <span className="font-bold">Encryption Status</span>
            <Lock size={20} className="text-emerald-400" />
          </div>
          <span className="text-3xl font-bold text-emerald-400">AES-256</span>
        </div>
        <div className="glass-card p-6 flex flex-col gap-2 border-emerald-500/20">
          <div className="flex justify-between items-center text-slate-400">
            <span className="font-bold">Exposed Variables</span>
            <ShieldAlert size={20} className="text-emerald-400" />
          </div>
          <span className="text-3xl font-bold text-emerald-400">0</span>
        </div>
      </div>

      {/* Secret List */}
      <div className="glass-card p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Server className="text-indigo-400" size={20} />
            Stored Configurations
          </h2>
          <button className="glow-btn py-2 px-4 text-sm" disabled>Add Config</button>
        </div>

        {loading ? (
             <div className="flex justify-center items-center py-8 text-slate-500"><Loader2 className="animate-spin mr-2"/> Scanning vault...</div>
        ) : storages.length === 0 ? (
             <div className="text-center py-8 text-slate-500">No storage configurations found. Use the Policy Wizard to configure backup storage.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {storages.map((storage, idx) => (
              <div key={idx} className="p-4 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between group hover:border-blue-500/40 transition-all">
                <div className="flex items-center gap-4">
                   <div className="p-3 bg-slate-800 rounded-lg group-hover:bg-blue-900/50 transition-colors">
                      {storage.type === 's3' ? <Database size={20} className="text-blue-400" /> : <Server size={20} className="text-indigo-400" />}
                   </div>
                   <div>
                      <h3 className="font-bold text-slate-200 capitalize">{storage.type} Mount</h3>
                      <p className="text-sm text-slate-500 font-mono mt-1 w-48 truncate sm:w-auto" title={storage.path || storage.endpoint}>Target: {storage.path || storage.endpoint}</p>
                   </div>
                </div>
                <div className="bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded border border-emerald-500/20 text-xs font-semibold">
                  Encrypted
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

