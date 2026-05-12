import React, { useState, useEffect, useRef } from 'react'
import { Backup } from '@docker-rescue-kit/shared'
import { listBackupFiles, extractBackupFileUrl } from '../api'
import { X, Folder, File, Download, RefreshCw, FolderOpen } from 'lucide-react'
import { EmptyState } from './EmptyState'

interface Props {
  backup: Backup
  onClose: () => void
}

interface Entry {
  path: string
  size: number
  mode: string
  mtime?: string
}

export const PartialRestoreBrowser: React.FC<Props> = ({ backup, onClose }) => {
  const [archive, setArchive] = useState<string>('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  }, [onClose])

  // Infer candidate archive names from target list. The PolicyManager names
  // backup files as `{type}_{selector}.tar.gz`, so derive from targets.
  const archives = backup.targets
    .filter(t => t.type === 'volume' || t.type === 'container')
    .map(t => `${t.type}_${t.selector.replace(/[^a-zA-Z0-9._-]/g, '_')}.tar.gz`)

  useEffect(() => {
    if (!archive && archives.length > 0) setArchive(archives[0])
  }, [archives, archive])

  const load = async () => {
    if (!archive) return
    setLoading(true)
    setError(null)
    try {
      setEntries(await listBackupFiles(backup.id, archive))
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [archive])

  const fmt = (n: number) => {
    if (!n) return '—'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(n) / Math.log(k))
    return (n / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
  }

  return (
    <div className="modal-overlay">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="partial-restore-title"
        className="modal-panel"
        style={{ maxWidth: 780 }}
      >
        <div className="flex items-center justify-between">
          <h3 id="partial-restore-title" className="text-lg font-bold flex items-center gap-2"><Folder size={18} /> Browse backup</h3>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={archive}
            onChange={e => setArchive(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg bg-slate-900 border border-white/10 text-sm"
          >
            {archives.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <button onClick={load} className="p-2 rounded-lg hover:bg-white/5 text-slate-400">
            <RefreshCw size={16} />
          </button>
        </div>

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto border border-white/5 rounded-lg">
          {loading ? (
            <div className="p-6 text-center text-slate-500 animate-pulse">Downloading archive and indexing…</div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<FolderOpen size={28} />}
              title="Archive is Empty"
              description="This backup archive contains no entries to browse. It may have been created from an empty volume or the manifest could not be read."
              action={{ label: 'Reload', onClick: load }}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-900/90 backdrop-blur text-xs text-slate-400">
                <tr>
                  <th className="text-left p-2 font-medium">Path</th>
                  <th className="text-right p-2 font-medium w-24">Size</th>
                  <th className="text-right p-2 font-medium w-32">Modified</th>
                  <th className="w-16"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const isDir = e.mode.startsWith('d')
                  return (
                    <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                      <td className="p-2 font-mono truncate max-w-[400px]" title={e.path}>
                        <span className="inline-flex items-center gap-2">
                          {isDir ? <Folder size={12} className="text-blue-400" /> : <File size={12} className="text-slate-400" />}
                          {e.path}
                        </span>
                      </td>
                      <td className="p-2 text-right font-mono text-xs text-slate-400">{fmt(e.size)}</td>
                      <td className="p-2 text-right text-xs text-slate-500">{e.mtime || '—'}</td>
                      <td className="p-2 text-right">
                        {!isDir && (
                          <a
                            href={extractBackupFileUrl(backup.id, archive, e.path)}
                            download
                            className="p-1.5 rounded hover:bg-blue-500/20 text-blue-400 inline-flex"
                            title="Download this file"
                          >
                            <Download size={14} />
                          </a>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg hover:bg-white/5 text-slate-300 text-sm">Close</button>
        </div>
      </div>
    </div>
  )
}
