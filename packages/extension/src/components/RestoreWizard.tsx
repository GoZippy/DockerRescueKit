import React, { useState, useEffect, useRef } from 'react'
import { Backup } from '@docker-rescue-kit/shared'
import { restoreBackup } from '../api'
import { X, ShieldAlert, Play, CheckCircle2, ArrowRight } from 'lucide-react'

interface Props {
  backup: Backup
  onClose: () => void
  onDone: () => void
}

export const RestoreWizard: React.FC<Props> = ({ backup, onClose, onDone }) => {
  const [dryRun, setDryRun] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [volumeOverrides, setVolumeOverrides] = useState<Record<string, string>>({})
  const modalRef = useRef<HTMLDivElement>(null)

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
  }, [onClose, result])

  const volumeTargets = backup.targets.filter(t => t.type === 'volume')

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const cleaned: Record<string, string> = {}
      for (const [src, dst] of Object.entries(volumeOverrides)) {
        if (dst && dst !== src) cleaned[src] = dst
      }
      const res = await restoreBackup(backup.id, {
        dryRun,
        targetOverrides: Object.keys(cleaned).length ? { volumes: cleaned } : undefined
      })
      setResult(res)
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message)
    } finally {
      setRunning(false)
    }
  }

  // ENTER-to-submit (final action depends on state)
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return
    if (running) return
    if (!result) {
      e.preventDefault()
      run()
    }
  }

  return (
    <div className="modal-overlay">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-wizard-title"
        onKeyDown={onPanelKeyDown}
        className="modal-panel"
        style={{ maxWidth: 560 }}
      >
        <div className="flex items-center justify-between">
          <h3 id="restore-wizard-title" className="text-lg font-bold">Restore Backup</h3>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="bg-white/5 rounded-lg p-3 text-sm">
          <div className="text-slate-400">Backup</div>
          <div className="font-mono">{backup.id}</div>
          <div className="text-xs text-slate-500 mt-1">
            {new Date(backup.timestamp).toLocaleString()} · {backup.targets.length} target(s)
          </div>
        </div>

        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-200">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            Restoring overwrites target contents. Do a dry-run first — it downloads every
            file and verifies SHA-256 without writing to Docker.
          </div>
        </div>

        {volumeTargets.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium text-slate-300">Volume restore targets</div>
            <p className="text-xs text-slate-500">
              Leave a field blank to restore in place. Enter a different name to restore
              into a new volume (useful for side-by-side validation).
            </p>
            <div className="space-y-2">
              {volumeTargets.map(t => (
                <div key={t.selector} className="flex items-center gap-2 text-sm">
                  <div className="font-mono text-slate-300 w-1/3 truncate" title={t.selector}>{t.selector}</div>
                  <ArrowRight size={14} className="text-slate-500 shrink-0" />
                  <input
                    type="text"
                    placeholder={t.selector}
                    value={volumeOverrides[t.selector] ?? ''}
                    onChange={e => setVolumeOverrides({ ...volumeOverrides, [t.selector]: e.target.value })}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-white/10 font-mono text-xs"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
          Dry run (verify only, don't write)
        </label>

        {result && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-sm text-emerald-200">
            <div className="flex items-center gap-2 font-medium mb-1">
              <CheckCircle2 size={16} /> {result.dryRun ? 'Dry run OK' : 'Restore complete'}
            </div>
            <ul className="text-xs list-disc pl-5">
              {result.restored.map((r: string, i: number) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg hover:bg-white/5 text-slate-300 text-sm">Close</button>
          {!result && (
            <button
              onClick={run}
              disabled={running}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm flex items-center gap-2 disabled:opacity-50"
            >
              <Play size={14} /> {running ? 'Running…' : dryRun ? 'Run dry run' : 'Restore now'}
            </button>
          )}
          {result && !result.dryRun && (
            <button onClick={onDone} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm">Done</button>
          )}
          {result && result.dryRun && (
            <button
              onClick={() => { setDryRun(false); setResult(null); run() }}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm"
            >
              Proceed with real restore
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
