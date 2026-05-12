import React, { useEffect, useState } from 'react'
import { getSettingsMeta, regenerateApiKey, getStatus, pauseScheduler, resumeScheduler, clearApiKey } from '../api'
import { Key, Database, Folder, RefreshCw, AlertTriangle, Copy, Check, Pause, Play, Loader2, LogOut } from 'lucide-react'

export const SettingsPage: React.FC = () => {
  const [meta, setMeta] = useState<any>(null)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [paused, setPaused] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [m, s] = await Promise.all([getSettingsMeta(), getStatus()])
      setMeta(m)
      setPaused(!!s?.paused)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const togglePause = async () => {
    if (paused) await resumeScheduler()
    else await pauseScheduler()
    await load()
  }

  const regen = async () => {
    if (!confirm('Regenerate the API key? Update any CLI / integrations that stored the old key.')) return
    const res = await regenerateApiKey()
    setNewKey(res.apiKey)
  }

  const copy = () => {
    if (!newKey) return
    navigator.clipboard.writeText(newKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, gap: 8, color: 'var(--text-muted)' }}>
        <Loader2 size={16} className="animate-spin" /> Loading settings…
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 680 }}>

      {/* Runtime info */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 12 }}>
          <Database size={16} color="var(--text-muted)" /> Runtime
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: 0 }}>
          {[
            ['Version',          meta?.version],
            ['Data directory',   meta?.dataDir],
            ['Staging directory',meta?.staging],
            ['Encryption key',   meta?.hasEncryptionKey ? '✓ Initialized' : '✗ Missing'],
          ].map(([k, v]) => (
            <div key={k as string}>
              <dt style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{k}</dt>
              <dd className="font-mono" style={{
                fontSize: 12, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: k === 'Encryption key' ? (meta?.hasEncryptionKey ? 'var(--emerald)' : 'var(--rose)') : 'var(--text-primary)',
              }}>
                {v as string}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* API Key */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          <Key size={16} color="var(--text-muted)" /> API Key
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          Required for every <span className="font-mono">/api/*</span> call, including the <span className="font-mono">drk</span> CLI.
          Stored in <span className="font-mono">{meta?.dataDir}/secrets.json</span> (mode 0600).
        </p>

        {newKey && (
          <div style={{
            background: 'var(--amber-dim)', border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 'var(--r-md)', padding: '10px 12px', marginBottom: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12, color: '#fbbf24', marginBottom: 6 }}>
              <AlertTriangle size={14} /> Save this key — it will not be shown again.
            </div>
            <div className="font-mono" style={{
              background: 'var(--surface-0)', borderRadius: 'var(--r-sm)',
              padding: '8px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, wordBreak: 'break-all',
            }}>
              <span style={{ flex: 1 }}>{newKey}</span>
              <button className="btn-icon" onClick={copy} style={{ flexShrink: 0 }}>
                {copied ? <Check size={14} color="var(--emerald)" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        )}

        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 6,
          background: 'var(--amber-dim)',
          border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: 'var(--r-md)',
          padding: '10px 12px',
          marginBottom: 12,
          fontSize: 12,
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
        }}>
          <AlertTriangle size={14} color="#fbbf24" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            <strong style={{ color: '#fbbf24' }}>Regenerating invalidates the old key immediately.</strong>{' '}
            Update CLI/integrations before regenerating.
          </span>
        </div>

        <button className="btn btn-danger" onClick={regen}>
          <RefreshCw size={14} /> Regenerate API key
        </button>
      </div>

      {/* Scheduler */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          {paused
            ? <Pause size={16} color="var(--amber)" />
            : <Play  size={16} color="var(--emerald)" />}
          Scheduler
          <span className={`badge ${paused ? 'badge-warning' : 'badge-success'}`} style={{ marginLeft: 4 }}>
            {paused ? 'Paused' : 'Running'}
          </span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          {paused
            ? 'Cron-triggered backups and verify runs are being skipped. Manual runs from the UI or CLI still work.'
            : 'The scheduler is active. Pause it during upgrades or planned maintenance.'}
        </p>
        <button
          className={`btn ${paused ? 'btn-primary' : 'btn-ghost'}`}
          onClick={togglePause}
        >
          {paused ? <><Play size={14} /> Resume scheduler</> : <><Pause size={14} /> Pause scheduler</>}
        </button>
      </div>

      {/* Dependencies */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          <Folder size={16} color="var(--text-muted)" /> Backend dependencies
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
          Remote storage adapters shell out to <span className="font-mono">restic</span> (and optionally <span className="font-mono">rclone</span>).
          The shipped Docker image bundles both. Running the backend outside Docker requires installing them separately.
        </p>
      </div>

      {/* Disconnect */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          <LogOut size={16} color="var(--text-muted)" /> Switch instance
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          Clear the stored API key and return to the connection screen.
          Use this to connect to a different Docker Rescue Kit instance.
        </p>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm('Disconnect from this instance? You will need to re-enter the API key.')) {
              clearApiKey()
            }
          }}
        >
          <LogOut size={14} /> Disconnect
        </button>
      </div>
    </div>
  )
}
