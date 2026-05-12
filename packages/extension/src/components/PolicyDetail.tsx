import React, { useEffect, useState } from 'react'
import { BackupPolicy, Backup } from '@docker-rescue-kit/shared'
import { getPolicyHistory, runPolicy, updatePolicy, verifyPolicy } from '../api'
import { Play, ShieldCheck, CheckCircle2, AlertCircle, Clock, X, Pencil, Save } from 'lucide-react'

interface Props {
  policy: BackupPolicy
  onClose: () => void
  onChange: () => void
}

export const PolicyDetail: React.FC<Props> = ({ policy, onClose, onChange }) => {
  const [history, setHistory] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({
    name: policy.name,
    schedule: policy.schedule,
    verifySchedule: policy.verifySchedule || '',
    enabled: policy.enabled
  })

  const load = async () => {
    setLoading(true)
    try {
      setHistory(await getPolicyHistory(policy.id))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [policy.id])

  const runNow = async () => {
    await runPolicy(policy.id)
    await load()
    onChange()
  }

  const verifyNow = async () => {
    await verifyPolicy(policy.id)
  }

  const save = async () => {
    await updatePolicy(policy.id, {
      name: draft.name,
      schedule: draft.schedule,
      verifySchedule: draft.verifySchedule || undefined,
      enabled: draft.enabled
    })
    setEditing(false)
    onChange()
  }

  const lastSuccess = history.find(h => h.status === 'success')
  const lastFailure = history.find(h => h.status === 'failed')

  return (
    <div className="modal-overlay">
      <div className="modal-panel" style={{ maxWidth: 720 }}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">{policy.name}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="bg-white/5 rounded-lg p-3">
            <div className="text-xs text-slate-500 uppercase">Targets</div>
            <div className="font-bold">{policy.targets.length}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <div className="text-xs text-slate-500 uppercase">Last success</div>
            <div className="font-bold">{lastSuccess ? new Date(lastSuccess.timestamp).toLocaleString() : '—'}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <div className="text-xs text-slate-500 uppercase">Last failure</div>
            <div className="font-bold">{lastFailure ? new Date(lastFailure.timestamp).toLocaleString() : '—'}</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={runNow} className="px-3 py-1.5 rounded-lg bg-blue-600/20 text-blue-300 border border-blue-500/30 text-sm flex items-center gap-2">
            <Play size={14} /> Run now
          </button>
          <button onClick={verifyNow} className="px-3 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 text-sm flex items-center gap-2">
            <ShieldCheck size={14} /> Verify latest
          </button>
          <button onClick={() => setEditing(!editing)} className="px-3 py-1.5 rounded-lg hover:bg-white/5 text-slate-300 text-sm flex items-center gap-2">
            <Pencil size={14} /> {editing ? 'Cancel edit' : 'Edit'}
          </button>
        </div>

        {editing && (
          <div className="glass-card p-4 space-y-3">
            <label className="block">
              <span className="text-xs text-slate-400 uppercase">Name</span>
              <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className="w-full bg-slate-900 border border-white/10 rounded p-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400 uppercase">Backup schedule</span>
              <input value={draft.schedule} onChange={e => setDraft({ ...draft, schedule: e.target.value })} className="w-full bg-slate-900 border border-white/10 rounded p-2 font-mono text-sm" />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400 uppercase">Verify schedule</span>
              <input value={draft.verifySchedule} onChange={e => setDraft({ ...draft, verifySchedule: e.target.value })} placeholder="optional cron" className="w-full bg-slate-900 border border-white/10 rounded p-2 font-mono text-sm" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
              Enabled
            </label>
            <button onClick={save} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm flex items-center gap-2 self-start">
              <Save size={14} /> Save
            </button>
          </div>
        )}

        <div>
          <h4 className="text-sm font-bold mb-2 flex items-center gap-2"><Clock size={14} /> Recent runs</h4>
          {loading ? (
            <div className="text-sm text-slate-500 animate-pulse">Loading…</div>
          ) : history.length === 0 ? (
            <div className="text-sm text-slate-500">No runs yet.</div>
          ) : (
            <div className="divide-y divide-white/5 text-sm">
              {history.slice(0, 20).map(b => (
                <div key={b.id} className="py-2 flex items-center gap-3">
                  {b.status === 'success' ? <CheckCircle2 className="text-emerald-400" size={16} /> : <AlertCircle className="text-rose-400" size={16} />}
                  <span className="font-mono text-xs">{b.id.slice(0, 8)}</span>
                  <span className="text-xs text-slate-400">{new Date(b.timestamp).toLocaleString()}</span>
                  <span className="text-xs text-slate-500 ml-auto">{(b.duration / 1000).toFixed(1)}s</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
