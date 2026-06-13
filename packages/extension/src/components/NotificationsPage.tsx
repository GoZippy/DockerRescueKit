import React, { useEffect, useState, useCallback } from 'react'
import {
  Bell, BellOff, Check, CheckCheck, RefreshCw, Loader2, Sparkles, ExternalLink,
  Activity, RotateCw, ArchiveX, HardDrive, ShieldAlert, Send,
  type LucideProps,
} from 'lucide-react'
import {
  getNotificationLog, getNotificationPreferences, saveNotificationPreferences,
  acknowledgeNotification, acknowledgeAllNotifications, sendTestNotification,
  isPaymentRequired,
  type NotificationLogItem, type NotificationPreferencesDTO,
  type NotificationEventType, type NotificationSink,
} from '../api'
import { useToast } from '../hooks/useToast'

// Personal Pro pricing/copy — kept in sync with docs/ROADMAP.md Schedule A.
const UPGRADE_URL = 'https://gozippy.com/drk/personal-pro'

const EVENT_META: Record<NotificationEventType, { label: string; icon: React.FC<LucideProps> }> = {
  unhealthy:      { label: 'Unhealthy container',  icon: Activity },
  restart_loop:   { label: 'Restart loop',          icon: RotateCw },
  no_backup:      { label: 'Volume without backup', icon: ArchiveX },
  disk_pressure:  { label: 'Disk pressure',         icon: HardDrive },
  restore_failed: { label: 'Restore test failed',   icon: ShieldAlert },
}

const SINK_META: { id: NotificationSink; label: string; hint: string }[] = [
  { id: 'webhook', label: 'Webhook',  hint: 'Generic JSON POST (Slack-compatible, n8n, etc.)' },
  { id: 'ntfy',    label: 'ntfy',     hint: 'Self-hosted / ntfy.sh push topic' },
  { id: 'email',   label: 'Email',    hint: 'Your own SMTP server (no third-party)' },
]

function timeAgo(iso?: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

// ── Free-tier paywall card — tasteful, honest, one link, no nag. ───────────
const UpgradeCard: React.FC = () => (
  <div
    style={{
      maxWidth: 520, margin: '32px auto', padding: 24,
      background: 'var(--surface-1)', border: '1px solid var(--surface-4)',
      borderRadius: 12, textAlign: 'center',
    }}
  >
    <div style={{
      width: 44, height: 44, borderRadius: 10, margin: '0 auto 14px',
      background: 'var(--blue-500)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Bell size={22} color="#fff" />
    </div>
    <h2 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 700 }}>
      Proactive notifications
    </h2>
    <p style={{ margin: '0 0 6px', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
      Get alerted before things break — unhealthy containers, restart loops,
      volumes without backups, disk pressure, and failed restore tests —
      delivered to webhook, ntfy, or your own SMTP.
    </p>
    <p style={{ margin: '0 0 18px', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
      Notifications are part of <strong>Personal Pro</strong> — a{' '}
      <strong>$29 one-time</strong> upgrade that also unlocks unlimited policies,
      a 90-day audit log, and BYOK encryption. Lifetime updates within the
      current major version.
    </p>
    <a
      href={UPGRADE_URL}
      target="_blank"
      rel="noreferrer"
      className="btn btn-primary"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
    >
      <Sparkles size={15} />
      Learn about Personal Pro
      <ExternalLink size={13} />
    </a>
  </div>
)

interface Props {
  /** When provided, the parent (App) can keep its bell badge in sync after
   *  the user acknowledges items here. */
  onUnreadChange?: () => void
}

export const NotificationsPage: React.FC<Props> = ({ onUnreadChange }) => {
  const { push } = useToast()
  const [loading, setLoading] = useState(true)
  const [locked, setLocked] = useState(false)        // 402 — Free tier
  const [errored, setErrored] = useState(false)
  const [items, setItems] = useState<NotificationLogItem[]>([])
  const [prefs, setPrefs] = useState<NotificationPreferencesDTO | null>(null)
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [testing, setTesting] = useState<NotificationSink | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErrored(false)
    setLocked(false)
    try {
      const [page, p] = await Promise.all([
        getNotificationLog({ limit: 100 }),
        getNotificationPreferences(),
      ])
      setItems(page.entries)
      setPrefs(p)
    } catch (e) {
      if (isPaymentRequired(e)) {
        setLocked(true)
      } else {
        console.error('Failed to load notifications', e)
        setErrored(true)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const ack = async (id: string) => {
    // optimistic
    setItems(prev => prev.map(i => i.id === id ? { ...i, acknowledgedAt: new Date().toISOString() } : i))
    try {
      await acknowledgeNotification(id)
      onUnreadChange?.()
    } catch (e) {
      push('error', 'Could not acknowledge notification')
      load()
    }
  }

  const ackAll = async () => {
    try {
      await acknowledgeAllNotifications()
      setItems(prev => prev.map(i => i.acknowledgedAt ? i : { ...i, acknowledgedAt: new Date().toISOString() }))
      onUnreadChange?.()
    } catch {
      push('error', 'Could not acknowledge all')
    }
  }

  const persistPrefs = async (next: NotificationPreferencesDTO) => {
    setPrefs(next)
    setSavingPrefs(true)
    try {
      const saved = await saveNotificationPreferences({
        enabled: next.enabled,
        frequencies: next.frequencies,
        deliveryChannels: next.deliveryChannels,
        webhookUrl: next.webhookUrl,
        ntfyUrl: next.ntfyUrl,
        emailTo: next.emailTo,
        customThresholds: next.customThresholds,
      })
      // keep emailAvailable hint (server only returns it on GET)
      setPrefs(prev => ({ ...saved, emailAvailable: prev?.emailAvailable }))
    } catch (e: any) {
      push('error', e?.response?.data?.error || 'Could not save preferences')
      load()
    } finally {
      setSavingPrefs(false)
    }
  }

  const toggleSink = (sink: NotificationSink) => {
    if (!prefs) return
    const has = prefs.deliveryChannels.includes(sink)
    const deliveryChannels = has
      ? prefs.deliveryChannels.filter(s => s !== sink)
      : [...prefs.deliveryChannels, sink]
    persistPrefs({ ...prefs, deliveryChannels })
  }

  const toggleEvent = (evt: NotificationEventType) => {
    if (!prefs) return
    persistPrefs({ ...prefs, enabled: { ...prefs.enabled, [evt]: !prefs.enabled[evt] } })
  }

  const testSink = async (sink: NotificationSink) => {
    setTesting(sink)
    try {
      const res = await sendTestNotification(sink)
      if (res.ok) push('success', `Test ${sink} notification sent`)
      else push('error', `Test failed: ${res.error || 'unknown error'}`)
    } catch (e) {
      push('error', isPaymentRequired(e) ? 'Notifications require Personal Pro' : `Test ${sink} failed`)
    } finally {
      setTesting(null)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
        <Loader2 size={22} className="animate-spin" />
      </div>
    )
  }
  if (locked) return <UpgradeCard />
  if (errored) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Couldn’t load notifications.</p>
        <button className="btn btn-ghost" onClick={load}><RefreshCw size={14} /> Retry</button>
      </div>
    )
  }

  const unreadCount = items.filter(i => !i.acknowledgedAt).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 760 }}>
      {/* Preferences */}
      {prefs && (
        <section style={{ background: 'var(--surface-1)', border: '1px solid var(--surface-4)', borderRadius: 10, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Delivery sinks</h3>
            {savingPrefs && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--text-muted)' }} />}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {SINK_META.map(s => {
              const on = prefs.deliveryChannels.includes(s.id)
              const emailUnavailable = s.id === 'email' && prefs.emailAvailable === false
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: emailUnavailable ? 'not-allowed' : 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={emailUnavailable}
                      onChange={() => toggleSink(s.id)}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {emailUnavailable ? 'unavailable — no SMTP configured (set it in Settings)' : s.hint}
                    </span>
                  </label>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, padding: '2px 8px' }}
                    disabled={!on || testing === s.id || emailUnavailable}
                    onClick={() => testSink(s.id)}
                    title="Send a real test notification to this sink"
                  >
                    {testing === s.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    Test
                  </button>
                </div>
              )
            })}
          </div>

          {/* Per-sink targets */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
            {prefs.deliveryChannels.includes('webhook') && (
              <TargetField
                label="Webhook URL" placeholder="https://hooks.example.com/notify"
                value={prefs.webhookUrl || ''}
                onCommit={v => persistPrefs({ ...prefs, webhookUrl: v })}
              />
            )}
            {prefs.deliveryChannels.includes('ntfy') && (
              <TargetField
                label="ntfy topic URL" placeholder="https://ntfy.sh/my-drk-alerts"
                value={prefs.ntfyUrl || ''}
                onCommit={v => persistPrefs({ ...prefs, ntfyUrl: v })}
              />
            )}
            {prefs.deliveryChannels.includes('email') && prefs.emailAvailable !== false && (
              <TargetField
                label="Email recipient" placeholder="ops@example.com"
                value={prefs.emailTo || ''}
                onCommit={v => persistPrefs({ ...prefs, emailTo: v })}
              />
            )}
          </div>

          <h3 style={{ margin: '18px 0 10px', fontSize: 14, fontWeight: 700 }}>Event types</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {(Object.keys(EVENT_META) as NotificationEventType[]).map(evt => {
              const { label, icon: Icon } = EVENT_META[evt]
              return (
                <label key={evt} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={!!prefs.enabled[evt]} onChange={() => toggleEvent(evt)} />
                  <Icon size={15} style={{ color: 'var(--text-muted)' }} />
                  {label}
                </label>
              )
            })}
          </div>
        </section>
      )}

      {/* Notification log */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
            Recent notifications {unreadCount > 0 && <span style={{ color: 'var(--blue-500)' }}>({unreadCount} unread)</span>}
          </h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={load}>
              <RefreshCw size={13} /> Refresh
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={unreadCount === 0} onClick={ackAll}>
              <CheckCheck size={13} /> Mark all read
            </button>
          </div>
        </div>

        {items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
            <BellOff size={26} style={{ opacity: 0.5 }} />
            <p style={{ fontSize: 13, margin: '8px 0 0' }}>No notifications yet. You’ll see proactive alerts here.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map(item => {
              const meta = EVENT_META[item.eventType]
              const Icon = meta?.icon || Bell
              const acked = !!item.acknowledgedAt
              const critical = item.severity === 'critical'
              return (
                <div
                  key={item.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                    background: acked ? 'var(--surface-1)' : 'var(--surface-2)',
                    border: '1px solid var(--surface-4)',
                    borderLeft: `3px solid ${critical ? 'var(--red-500, #ef4444)' : 'var(--blue-500)'}`,
                    borderRadius: 8, opacity: acked ? 0.7 : 1,
                  }}
                >
                  <Icon size={17} style={{ color: critical ? 'var(--red-500, #ef4444)' : 'var(--blue-500)', flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {item.payload?.subject || meta?.label || item.eventType}
                    </div>
                    {item.payload?.message && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
                        {item.payload.message}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span>{timeAgo(item.createdAt)}</span>
                      {item.status === 'failed' && <span style={{ color: 'var(--red-500, #ef4444)' }}>delivery failed</span>}
                      {item.deliveryChannel && <span>via {item.deliveryChannel}</span>}
                    </div>
                  </div>
                  {!acked && (
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}
                      onClick={() => ack(item.id)}
                      title="Mark as read"
                    >
                      <Check size={12} /> Read
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

// Small uncontrolled-on-blur text field so we only persist when the user
// finishes typing (avoids a save per keystroke).
const TargetField: React.FC<{
  label: string; placeholder: string; value: string; onCommit: (v: string) => void
}> = ({ label, placeholder, value, onCommit }) => {
  const [local, setLocal] = useState(value)
  useEffect(() => { setLocal(value) }, [value])
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <input
        className="form-input"
        type="text"
        value={local}
        placeholder={placeholder}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => { if (local !== value) onCommit(local.trim()) }}
        style={{ fontSize: 13 }}
      />
    </label>
  )
}
