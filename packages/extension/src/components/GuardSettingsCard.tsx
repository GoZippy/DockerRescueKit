/**
 * GuardSettingsCard — Prune Guard configuration widget for the Dashboard.
 *
 * §10.2 layout:
 *   - Big On/Off toggle (friendly, free)
 *   - Scope radio (3 options with one-line plain-language explanations)
 *   - Disk budget input + current-usage bar
 *   - Snapshot cadence via CronPicker presets
 *   - Advanced section (collapsed): per-volume cap, TTL, fail-closed (greyed)
 *
 * §10.3 copy rules: no "prune"/"tarball"; lead with reassurance; one primary
 *   button. Free-tier onboarding framing in empty/first-load state.
 *
 * Graceful degradation: if GET /api/guard/settings returns 404, renders nothing.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, ChevronDown, ChevronUp, Info, HardDrive } from 'lucide-react'
import { GuardSettings, GuardScope } from '@docker-rescue-kit/shared'
import { getGuardSettings, updateGuardSettings, listGuardEvents } from '../api'
import { useToast } from '../hooks/useToast'
import { CronPicker } from './CronPicker'

// ── Scope descriptions (plain language, §10.3) ────────────────────────────

const SCOPE_OPTIONS: Array<{ value: GuardScope; label: string; desc: string }> = [
  {
    value: 'protected',
    label: 'Protected volumes only',
    desc: 'Saves copies of volumes that are part of a DRK backup policy or protected stack.',
  },
  {
    value: 'named',
    label: 'All named volumes (recommended)',
    desc: "Saves copies of every named Docker volume on this host — the safest default if you haven't set up policies yet.",
  },
  {
    value: 'all-named-under-cap',
    label: 'All named volumes under the size cap',
    desc: 'Same as above but skips volumes larger than the per-volume cap to keep things fast.',
  },
]

const fmt = (bytes: number) => {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

// ── Main component ────────────────────────────────────────────────────────

export const GuardSettingsCard: React.FC = () => {
  const toast = useToast()

  // null = loading; false = 404 / unavailable
  const [settings, setSettings] = useState<GuardSettings | null | false>(null)
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Disk usage from recent events (sum of totalBytes for non-expired)
  const [usedBytes, setUsedBytes] = useState(0)

  // Local draft — only written to server on blur / explicit change
  const [draft, setDraft] = useState<GuardSettings | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await getGuardSettings()
      setSettings(s)
      setDraft(s)
    } catch (e: any) {
      if (e?.response?.status === 404 || e?.status === 404) {
        setSettings(false)
        return
      }
      setSettings(false)
    }

    // Load usage (best-effort — 404 just means no events yet)
    try {
      const evts = await listGuardEvents({ limit: 100 })
      const used = evts
        .filter(ev => ev.status !== 'expired')
        .reduce((a, ev) => a + (ev.totalBytes ?? 0), 0)
      setUsedBytes(used)
    } catch {
      // silently ignore
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const patch = async (changes: Partial<GuardSettings>) => {
    if (!draft) return
    const next = { ...draft, ...changes }
    setDraft(next)
    setSaving(true)
    try {
      const saved = await updateGuardSettings(changes)
      setSettings(saved)
      setDraft(saved)
    } catch {
      toast.push('error', 'Could not save Prune Guard settings — check the backend logs.')
      // revert draft
      if (settings) setDraft(settings as GuardSettings)
    } finally {
      setSaving(false)
    }
  }

  // Feature not available (404) or still loading — render nothing
  if (settings === false) return null
  if (settings === null || draft === null) return null

  const budgetMb = draft.diskBudgetMb ?? 2048
  const usedMb = usedBytes / (1024 * 1024)
  const usedPct = Math.min(100, budgetMb > 0 ? Math.round((usedMb / budgetMb) * 100) : 0)
  const budgetWarning = usedPct >= 85

  return (
    <div
      className="card"
      style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: 0, overflow: 'hidden' }}
      aria-label="Prune Guard settings"
    >
      {/* ── Card header + master toggle ─────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 16px',
        borderBottom: draft.enabled ? '1px solid var(--surface-4)' : 'none',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
          background: draft.enabled ? 'var(--emerald-dim)' : 'var(--surface-3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <ShieldCheck size={18} color={draft.enabled ? 'var(--emerald)' : 'var(--text-muted)'} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.2, marginBottom: 2 }}>
            Prune Guard
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {draft.enabled
              ? 'On — automatically saving copies before cleanups'
              : 'Off — your data is not being automatically saved'}
          </div>
        </div>

        {/* Big friendly toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          aria-label={draft.enabled ? 'Disable Prune Guard' : 'Enable Prune Guard'}
          disabled={saving}
          onClick={() => patch({ enabled: !draft.enabled })}
          style={{
            flexShrink: 0,
            width: 52,
            height: 28,
            borderRadius: 100,
            border: 'none',
            cursor: saving ? 'not-allowed' : 'pointer',
            background: draft.enabled ? 'var(--emerald)' : 'var(--surface-4)',
            position: 'relative',
            transition: 'background 0.2s',
            opacity: saving ? 0.6 : 1,
          }}
        >
          <span style={{
            position: 'absolute',
            top: 3,
            left: draft.enabled ? 26 : 3,
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.2s',
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }} />
        </button>
      </div>

      {/* Onboarding / empty state (shown only when first-load, no events, enabled) */}
      {draft.enabled && usedBytes === 0 && (
        <div style={{
          padding: '10px 16px',
          background: 'var(--blue-dim)',
          borderBottom: '1px solid var(--surface-4)',
          display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <Info size={14} color="var(--blue-500)" style={{ flexShrink: 0, marginTop: 1 }} />
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--text-primary)' }}>Prune Guard is on and free.</strong>{' '}
            If an AI agent (or you) ever runs a destructive cleanup or stack shutdown, DRK keeps
            a copy so you can undo it. Prompts and denylists get bypassed — backups don&apos;t.
          </p>
        </div>
      )}

      {/* ── Settings body (only when enabled) ───────────────────────── */}
      {draft.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

          {/* Scope */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--surface-4)' }}>
            <div className="form-label" style={{ marginBottom: 8 }}>What to protect</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {SCOPE_OPTIONS.map(opt => (
                <label
                  key={opt.value}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                    padding: '9px 12px',
                    borderRadius: 'var(--r-md)',
                    border: '1px solid',
                    borderColor: draft.scope === opt.value ? 'var(--blue-500)' : 'var(--surface-4)',
                    background: draft.scope === opt.value ? 'var(--blue-dim)' : 'var(--surface-1)',
                    transition: 'all 0.12s',
                  }}
                >
                  <input
                    type="radio"
                    name="guard-scope"
                    value={opt.value}
                    checked={draft.scope === opt.value}
                    onChange={() => patch({ scope: opt.value })}
                    disabled={saving}
                    style={{ marginTop: 2, flexShrink: 0, accentColor: 'var(--blue-500)' }}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 2 }}>{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Disk budget */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--surface-4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <label htmlFor="guard-budget" className="form-label" style={{ margin: 0 }}>
                Storage budget for saved copies
              </label>
              <span style={{
                fontSize: 11,
                color: budgetWarning ? 'var(--amber)' : 'var(--text-muted)',
                fontWeight: budgetWarning ? 600 : 400,
              }}>
                {fmt(usedBytes)} / {budgetMb} MB used
              </span>
            </div>

            {/* Usage bar */}
            <div className="progress-bar" style={{ marginBottom: 10 }}>
              <div
                className="progress-bar-fill"
                style={{
                  width: `${usedPct}%`,
                  background: usedPct >= 90
                    ? 'linear-gradient(to right, var(--amber), var(--rose))'
                    : usedPct >= 75
                    ? 'var(--amber)'
                    : 'var(--emerald)',
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <HardDrive size={13} color="var(--text-muted)" />
              <input
                id="guard-budget"
                type="number"
                min={256}
                max={65536}
                step={256}
                value={draft.diskBudgetMb}
                disabled={saving}
                onChange={e => {
                  const v = parseInt(e.target.value, 10)
                  if (Number.isFinite(v) && v >= 256) setDraft(d => d ? { ...d, diskBudgetMb: v } : d)
                }}
                onBlur={e => {
                  const v = parseInt(e.target.value, 10)
                  if (Number.isFinite(v) && v >= 256) patch({ diskBudgetMb: v })
                }}
                className="form-input"
                style={{ width: 100, textAlign: 'right' }}
                aria-label="Disk budget in megabytes"
              />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>MB max</span>
            </div>
          </div>

          {/* Snapshot cadence */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--surface-4)' }}>
            <div className="form-label" style={{ marginBottom: 8 }}>
              Automatically save copies on this schedule
            </div>
            <CronPicker
              value={draft.periodicCron}
              onChange={cron => patch({ periodicCron: cron })}
            />
          </div>

          {/* Advanced (collapsed) */}
          <div style={{ padding: '10px 16px' }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '5px 10px', width: '100%', justifyContent: 'space-between' }}
              onClick={() => setAdvancedOpen(o => !o)}
              aria-expanded={advancedOpen}
              aria-controls="guard-advanced"
            >
              <span>Advanced settings</span>
              {advancedOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            {advancedOpen && (
              <div
                id="guard-advanced"
                style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}
              >
                {/* Per-volume cap */}
                <div>
                  <label htmlFor="guard-vol-cap" className="form-label">
                    Per-volume size cap
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      id="guard-vol-cap"
                      type="number"
                      min={64}
                      max={8192}
                      step={64}
                      value={draft.perVolumeCapMb}
                      disabled={saving}
                      onChange={e => {
                        const v = parseInt(e.target.value, 10)
                        if (Number.isFinite(v) && v >= 64) setDraft(d => d ? { ...d, perVolumeCapMb: v } : d)
                      }}
                      onBlur={e => {
                        const v = parseInt(e.target.value, 10)
                        if (Number.isFinite(v) && v >= 64) patch({ perVolumeCapMb: v })
                      }}
                      className="form-input"
                      style={{ width: 100, textAlign: 'right' }}
                      aria-label="Per-volume size cap in megabytes"
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>MB — volumes above this are skipped</span>
                  </div>
                </div>

                {/* TTL */}
                <div>
                  <label htmlFor="guard-ttl" className="form-label">
                    Keep saved copies for
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      id="guard-ttl"
                      type="number"
                      min={1}
                      max={720}
                      step={1}
                      value={draft.ttlHours}
                      disabled={saving}
                      onChange={e => {
                        const v = parseInt(e.target.value, 10)
                        if (Number.isFinite(v) && v >= 1) setDraft(d => d ? { ...d, ttlHours: v } : d)
                      }}
                      onBlur={e => {
                        const v = parseInt(e.target.value, 10)
                        if (Number.isFinite(v) && v >= 1) patch({ ttlHours: v })
                      }}
                      className="form-input"
                      style={{ width: 80, textAlign: 'right' }}
                      aria-label="TTL in hours"
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>hours, then they expire automatically</span>
                  </div>
                </div>

                {/* Fail-closed (greyed — requires proxy) */}
                <div style={{
                  padding: '10px 12px',
                  background: 'var(--surface-1)',
                  borderRadius: 'var(--r-md)',
                  border: '1px solid var(--surface-4)',
                  opacity: 0.55,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      id="guard-fail-closed"
                      checked={draft.failClosed}
                      disabled
                      aria-label="Block the operation if saving a copy fails (requires agent proxy)"
                    />
                    <label htmlFor="guard-fail-closed" style={{ fontSize: 13, fontWeight: 600, cursor: 'not-allowed' }}>
                      Block the operation if saving a copy fails
                    </label>
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    Requires the agent proxy — coming soon. With the proxy, if DRK can&apos;t
                    save a copy first, the destructive operation is blocked rather than allowed through.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
