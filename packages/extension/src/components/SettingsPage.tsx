import React, { useEffect, useRef, useState } from 'react'
import {
  getSettingsMeta, regenerateApiKey, getStatus, pauseScheduler, resumeScheduler, clearApiKey,
  getSetting, saveSetting,
  getLicenseStatus, checkVersion, submitFeedback, exportConfig, importConfig,
} from '../api'
import { openExternal, openMarketplace } from '../utils/openExternal'
import { ImportWizard } from './ImportWizard'
import { formatDistanceToNowStrict } from 'date-fns'
import { UpgradeBanner } from './UpgradeBanner'
import { useToast } from '../hooks/useToast'
import {
  Key, Database, Folder, RefreshCw, AlertTriangle, Copy, Check, Pause, Play, Loader2, LogOut,
  Info, ExternalLink, Bell, Webhook, Lock, CheckCircle2, Download, Github, Package, Upload, FileText,
} from 'lucide-react'

// ── Constants ────────────────────────────────────────────────────────────────
const DOCKER_HUB_URL  = 'https://hub.docker.com/r/gozippy/dockerrescuekit'
const GITHUB_URL      = 'https://github.com/gozippy/DockerRescueKit'
const LICENSE_URL     = 'https://github.com/gozippy/DockerRescueKit/blob/main/LICENSE'
const CHANGELOG_URL   = 'https://github.com/gozippy/DockerRescueKit/blob/main/CHANGELOG.md'

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatUptime(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

// Small section heading separator between card groups.
const SectionHeading: React.FC<{ children: React.ReactNode; first?: boolean }> = ({ children, first }) => (
  <h3 style={{
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    margin: first ? '0 0 8px' : '24px 0 8px',
  }}>
    {children}
  </h3>
)

// ── License tier pill ────────────────────────────────────────────────────────
type Tier = 'free' | 'pro' | 'enterprise' | 'unknown'

const TIER_STYLES: Record<Tier, { bg: string; fg: string; label: string }> = {
  free:       { bg: 'var(--surface-3)',  fg: 'var(--text-secondary)', label: 'Free' },
  pro:        { bg: 'rgba(59,130,246,0.18)',  fg: '#60a5fa',          label: 'Pro' },
  enterprise: { bg: 'rgba(234,179,8,0.18)',   fg: '#facc15',          label: 'Enterprise' },
  unknown:    { bg: 'var(--surface-3)',  fg: 'var(--text-muted)',     label: 'Unknown' },
}

const TierPill: React.FC<{ tier: Tier }> = ({ tier }) => {
  const s = TIER_STYLES[tier]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: s.bg, color: s.fg,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      {s.label}
    </span>
  )
}

// ── External link row (used in About card) ───────────────────────────────────
const ExtLink: React.FC<{ href: string; icon: React.ReactNode; children: React.ReactNode }> = ({
  href, icon, children,
}) => (
  <button
    type="button"
    onClick={() => openExternal(href)}
    style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px',
      background: 'transparent',
      border: '1px solid var(--surface-4)',
      borderRadius: 'var(--r-sm)',
      color: 'var(--text-secondary)',
      fontSize: 12,
      cursor: 'pointer',
      textAlign: 'left',
      width: '100%',
    }}
    onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)' }}
    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
  >
    {icon}
    <span style={{ flex: 1 }}>{children}</span>
    <ExternalLink size={12} style={{ opacity: 0.5 }} />
  </button>
)

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export const SettingsPage: React.FC = () => {
  const toast = useToast()
  const [meta, setMeta]         = useState<any>(null)
  const [status, setStatusObj]  = useState<any>(null)
  const [newKey, setNewKey]     = useState<string | null>(null)
  const [copied, setCopied]     = useState(false)
  const [loading, setLoading]   = useState(true)
  const [paused, setPaused]     = useState(false)

  // Sprint-1 (B1): data-safety banner — visible at top of Settings until
  // dismissed for the current session. Deliberately NOT persisted: every
  // fresh page load (or extension reload) brings the banner back, because
  // forgetting to export config has already cost users their backups.
  const [bannerDismissed, setBannerDismissed] = useState(false)

  // ── License state ──
  const [license, setLicense] = useState<{
    tier: Tier
    features: string[]
    expiresAt?: string
  } | null>(null)

  // ── Update-check state ──
  const [updateInfo, setUpdateInfo] = useState<{
    current: string
    latest: string | null
    updateAvailable: boolean
    checkedAt: string
    hubError?: string
  } | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateError, setUpdateError]       = useState<string | null>(null)

  // ── Notifications (SMTP) state ──
  const [smtp, setSmtp] = useState({
    host: '', port: '587', user: '', pass: '', secure: false, from: '',
  })

  // ── Feedback webhook state ──
  const [webhookUrl, setWebhookUrl]     = useState('')
  const [webhookBusy, setWebhookBusy]   = useState(false)
  const [webhookResult, setWebhookResult] = useState<string | null>(null)

  // ── Config export / import state ──
  const [exporting, setExporting]         = useState(false)
  const [exportError, setExportError]     = useState<string | null>(null)
  const [importing, setImporting]         = useState(false)
  const [importResult, setImportResult]   = useState<string | null>(null)
  const [importError, setImportError]     = useState<string | null>(null)
  const fileInputRef                      = useRef<HTMLInputElement>(null)

  // ── Import wizard (Sprint 3 — B2) ──
  const [importWizardOpen, setImportWizardOpen] = useState(false)

  // ── Initial load ────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true)
    try {
      const [m, s] = await Promise.all([
        getSettingsMeta().catch(() => null),
        getStatus().catch(() => null),
      ])
      setMeta(m)
      setStatusObj(s)
      setPaused(!!s?.paused)

      // License — degrade gracefully if endpoint doesn't exist yet.
      try {
        const lic = await getLicenseStatus()
        setLicense({
          tier: (lic?.tier as Tier) ?? 'unknown',
          features: Array.isArray(lic?.features) ? lic.features : [],
          expiresAt: lic?.expiresAt,
        })
      } catch {
        setLicense({ tier: 'unknown', features: [] })
      }

      // SMTP settings — best-effort load.
      try {
        const [host, port, user, pass, secure, from] = await Promise.all([
          getSetting('notifications.smtp.host').catch(() => null),
          getSetting('notifications.smtp.port').catch(() => null),
          getSetting('notifications.smtp.user').catch(() => null),
          getSetting('notifications.smtp.pass').catch(() => null),
          getSetting('notifications.smtp.secure').catch(() => null),
          getSetting('notifications.smtp.from').catch(() => null),
        ])
        setSmtp({
          host:   host   ?? '',
          port:   port   ?? '587',
          user:   user   ?? '',
          pass:   pass   ?? '',
          secure: secure === 'true',
          from:   from   ?? '',
        })
      } catch { /* ignore — defaults already set */ }

      // Feedback webhook URL.
      try {
        const w = await getSetting('feedback.webhook_url')
        setWebhookUrl(w ?? '')
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }

  // ── Lazy version check on mount ─────────────────────────────────────────
  const runVersionCheck = async () => {
    setUpdateChecking(true)
    setUpdateError(null)
    try {
      const res = await checkVersion()
      setUpdateInfo(res)
    } catch (e: any) {
      setUpdateError(e?.message ?? 'Version check failed')
    } finally {
      setUpdateChecking(false)
    }
  }

  useEffect(() => { load() }, [])

  // Defer the version check until the rest of the page has rendered.
  useEffect(() => {
    if (!loading) {
      runVersionCheck()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  // ── Handlers ────────────────────────────────────────────────────────────
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

  // SMTP auto-save on blur. Each field key persists separately.
  const persistSmtp = (key: keyof typeof smtp) => async () => {
    try {
      await saveSetting(`notifications.smtp.${key}`, String(smtp[key]))
    } catch (e) {
      console.warn(`Failed to save notifications.smtp.${key}`, e)
    }
  }

  const persistWebhook = async () => {
    try {
      await saveSetting('feedback.webhook_url', webhookUrl)
    } catch (e) {
      console.warn('Failed to save feedback.webhook_url', e)
    }
  }

  const sendWebhookTestPing = async () => {
    setWebhookBusy(true)
    setWebhookResult(null)
    try {
      const res = await submitFeedback({
        type: 'question',
        message: `[Test ping from Settings UI] ${new Date().toISOString()} — feedback_webhook.test`,
      })
      const sinks = (res && (res as any).sinks) || (res as any)?.delivered || res
      setWebhookResult(`OK — ${JSON.stringify(sinks)}`)
    } catch (e: any) {
      setWebhookResult(`Error — ${e?.message ?? String(e)}`)
    } finally {
      setWebhookBusy(false)
    }
  }

  // ── Config export / import handlers ──
  const handleExport = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const bundle = await exportConfig()
      // Trigger browser download
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `drk-config-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setExportError(e?.message ?? 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  // Sprint-1 (B1): toast-wrapped export used by the UpgradeBanner and the
  // Updates-card "Export config" promoted button. Same logic as handleExport
  // above, but surfaces success/failure via the global toast provider so the
  // outcome is visible regardless of which card was off-screen at the time.
  const exportConfigWithToast = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const bundle = await exportConfig()
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const fileName = `drk-config-${new Date().toISOString().slice(0, 10)}.json`
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.push('success', `Exported to ${fileName}`)
    } catch (e: any) {
      const msg = e?.message ?? 'Export failed'
      setExportError(msg)
      toast.push('error', `Export failed: ${msg}`)
    } finally {
      setExporting(false)
    }
  }

  const handleImportFile = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setImportResult(null)
    setImportError(null)
    try {
      const text = await file.text()
      const bundle = JSON.parse(text)
      if (!bundle.data) {
        throw new Error('Invalid config file: missing data field')
      }
      const res = await importConfig(bundle)
      setImportResult(`Imported — ${res.policiesImported} policies restored`)
    } catch (err: any) {
      setImportError(err?.message ?? 'Import failed')
    } finally {
      setImporting(false)
      // Reset file input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Loading state ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 200, gap: 8, color: 'var(--text-muted)',
      }}>
        <Loader2 size={16} className="animate-spin" /> Loading settings…
      </div>
    )
  }

  // ── Derived values ──────────────────────────────────────────────────────
  const tier: Tier = license?.tier ?? 'unknown'
  const isPro = tier === 'pro' || tier === 'enterprise'

  const dockerOnline = !!status?.docker
  const uptimeStr    = formatUptime(status?.uptime)
  const buildSha     = (import.meta as any).env?.VITE_BUILD_SHA as string | undefined
  const buildLabel   = buildSha ? buildSha.slice(0, 7) : 'dev build'

  const lastCheckedStr = updateInfo?.checkedAt
    ? `${formatDistanceToNowStrict(new Date(updateInfo.checkedAt))} ago`
    : null

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 680 }}>

      {/* ── Sprint-1 (B1): data-safety banner ────────────────────── */}
      {!bannerDismissed && (
        <UpgradeBanner
          lastExportAt={meta?.lastExportAt}
          onExportNow={exportConfigWithToast}
          onDismiss={() => setBannerDismissed(true)}
          exporting={exporting}
        />
      )}

      {/* ╔══════════════════════════════════════════════════════════════╗ */}
      {/* ║ SECTION: About this install                                   ║ */}
      {/* ╚══════════════════════════════════════════════════════════════╝ */}
      <SectionHeading first>About this install</SectionHeading>

      {/* ── Runtime ──────────────────────────────────────────────── */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 12 }}>
          <Database size={16} color="var(--text-muted)" /> Runtime
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: 0 }}>
          <div>
            <dt style={ROW_DT}>Version</dt>
            <dd className="font-mono" style={ROW_DD}>{meta?.version ?? '—'}</dd>
          </div>
          <div>
            <dt style={ROW_DT}>Data directory</dt>
            <dd className="font-mono" style={ROW_DD}>{meta?.dataDir ?? '—'}</dd>
          </div>
          <div>
            <dt style={ROW_DT}>Staging directory</dt>
            <dd className="font-mono" style={ROW_DD}>{meta?.staging ?? '—'}</dd>
          </div>
          <div>
            <dt style={ROW_DT}>Backup encryption</dt>
            <dd className="font-mono" style={{
              ...ROW_DD,
              color: meta?.hasEncryptionKey ? 'var(--emerald)' : 'var(--rose)',
            }}>
              {meta?.hasEncryptionKey ? '✓ Initialized' : '✗ Missing'}
            </dd>
          </div>
          <div>
            <dt style={ROW_DT}>Backend uptime</dt>
            <dd className="font-mono" style={ROW_DD}>{uptimeStr}</dd>
          </div>
          <div>
            <dt style={ROW_DT}>Docker daemon</dt>
            <dd style={{ margin: 0 }}>
              {status == null ? (
                <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
              ) : (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                  background: dockerOnline ? 'var(--emerald-dim)' : 'var(--rose-dim)',
                  color: dockerOnline ? 'var(--emerald)' : 'var(--rose)',
                }}>
                  {dockerOnline ? 'Connected' : 'Offline'}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* ── About (license + links) ─────────────────────────────── */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 12 }}>
          <Info size={16} color="var(--text-muted)" /> About
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
        }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>License:</span>
          <TierPill tier={tier} />
          {license?.expiresAt && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              expires {new Date(license.expiresAt).toLocaleDateString()}
            </span>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6, marginBottom: 14 }}>
          <ExtLink href={DOCKER_HUB_URL} icon={<Package size={13} color="var(--blue-500)" />}>
            Docker Hub
          </ExtLink>
          <ExtLink href={GITHUB_URL} icon={<Github size={13} color="var(--text-secondary)" />}>
            GitHub
          </ExtLink>
          <ExtLink href={LICENSE_URL} icon={<Lock size={13} color="var(--text-muted)" />}>
            License (Zippy Tech Source-Available v1.3)
          </ExtLink>
        </div>

        <div style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--surface-4)',
          borderRadius: 'var(--r-sm)',
          padding: '8px 10px',
          fontSize: 11,
          color: 'var(--text-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={ROW_DT}>Build info</span>
          <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            v{meta?.version ?? '?'} · {buildLabel}
          </span>
        </div>
      </div>

      {/* ╔══════════════════════════════════════════════════════════════╗ */}
      {/* ║ SECTION: Updates                                              ║ */}
      {/* ╚══════════════════════════════════════════════════════════════╝ */}
      <SectionHeading>Updates</SectionHeading>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 12 }}>
          <Download size={16} color="var(--text-muted)" /> Updates
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <dt style={ROW_DT}>Current</dt>
            <dd className="font-mono" style={ROW_DD}>
              v{updateInfo?.current ?? meta?.version ?? '?'}
            </dd>
          </div>
          <div>
            <dt style={ROW_DT}>Latest</dt>
            <dd className="font-mono" style={ROW_DD}>
              {updateChecking
                ? 'Checking…'
                : updateInfo?.hubError || updateError
                  ? '—'
                  : updateInfo?.latest
                    ? `v${updateInfo.latest}`
                    : '—'}
            </dd>
          </div>
        </div>

        {/* Update-available callout */}
        {updateInfo?.updateAvailable && updateInfo.latest && (
          <div style={{
            background: 'var(--amber-dim)',
            border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 'var(--r-md)',
            padding: '10px 12px',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <AlertTriangle size={16} color="#fbbf24" style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong style={{ color: '#fbbf24' }}>Update available: v{updateInfo.latest}</strong>
              {' — '}
              You're on v{updateInfo.current}.
            </span>
            <button
              className="btn btn-primary"
              onClick={() => openMarketplace('gozippy/dockerrescuekit')}
              style={{ flexShrink: 0 }}
            >
              <ExternalLink size={14} /> Open Marketplace
            </button>
          </div>
        )}

        {/* On-latest reassurance */}
        {updateInfo && !updateInfo.updateAvailable && !updateInfo.hubError && !updateError && (
          <div style={{
            background: 'var(--emerald-dim)',
            border: '1px solid rgba(16,185,129,0.25)',
            borderRadius: 'var(--r-md)',
            padding: '10px 12px',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <CheckCircle2 size={16} color="var(--emerald)" />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              You're on the latest version.
            </span>
          </div>
        )}

        {/* Hub error / unreachable */}
        {(updateInfo?.hubError || updateError) && (
          <div style={{
            background: 'var(--rose-dim)',
            border: '1px solid rgba(244,63,94,0.25)',
            borderRadius: 'var(--r-md)',
            padding: '10px 12px',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}>
            <AlertTriangle size={16} color="var(--rose)" />
            Couldn't reach Docker Hub: {updateInfo?.hubError ?? updateError}
          </div>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginTop: 4, flexWrap: 'wrap',
        }}>
          <button
            className="btn btn-ghost"
            onClick={runVersionCheck}
            disabled={updateChecking}
          >
            <RefreshCw size={14} className={updateChecking ? 'animate-spin' : undefined} />
            {updateChecking ? 'Checking…' : 'Check now'}
          </button>
          {/* Sprint-1 (B1): promoted Export button — high-visibility duplicate
              of the Danger-zone export, so users see it before they ever
              think about upgrading. */}
          <button
            className="btn btn-primary"
            onClick={exportConfigWithToast}
            disabled={exporting}
            title="Export DRK config — recommended before any upgrade or reinstall"
          >
            {exporting
              ? <><Loader2 size={14} className="animate-spin" /> Exporting…</>
              : <><Download size={14} /> Export config</>}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => openExternal(CHANGELOG_URL)}
          >
            <ExternalLink size={14} /> View changelog
          </button>
          {lastCheckedStr && !updateChecking && (
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
              Last checked: {lastCheckedStr}
            </span>
          )}
        </div>
      </div>

      {/* ╔══════════════════════════════════════════════════════════════╗ */}
      {/* ║ SECTION: Operations                                           ║ */}
      {/* ╚══════════════════════════════════════════════════════════════╝ */}
      <SectionHeading>Operations</SectionHeading>

      {/* ── API Key (unchanged) ─────────────────────────────────── */}
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
          display: 'flex', alignItems: 'flex-start', gap: 6,
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

      {/* ── Scheduler (unchanged) ───────────────────────────────── */}
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

      {/* ╔══════════════════════════════════════════════════════════════╗ */}
      {/* ║ SECTION: Integrations                                         ║ */}
      {/* ╚══════════════════════════════════════════════════════════════╝ */}
      <SectionHeading>Integrations</SectionHeading>

      {/* ── Notifications (SMTP) ────────────────────────────────── */}
      <div className="card" style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          <Bell size={16} color="var(--text-muted)" /> Notifications
          {isPro && <TierPill tier={tier} />}
        </div>

        {!isPro ? (
          <div style={{ position: 'relative' }}>
            {/* Greyed-out preview form */}
            <div style={{
              opacity: 0.35,
              pointerEvents: 'none',
              userSelect: 'none',
              filter: 'blur(0.5px)',
            }}>
              <SmtpForm smtp={smtp} setSmtp={setSmtp} persist={() => () => {}} />
            </div>
            {/* Lock overlay */}
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 8, textAlign: 'center',
              background: 'linear-gradient(180deg, rgba(15,23,42,0.65), rgba(15,23,42,0.85))',
              borderRadius: 'var(--r-md)',
            }}>
              <div style={{
                width: 42, height: 42, borderRadius: 10,
                background: 'rgba(59,130,246,0.18)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Lock size={20} color="#60a5fa" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Notifications require a Pro license</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 320 }}>
                Email alerts for backup failures, rehearsal results and version updates.
              </div>
              <button
                className="btn btn-primary"
                onClick={() => openExternal(LICENSE_URL)}
                style={{ marginTop: 4 }}
              >
                <ExternalLink size={14} /> Learn more
              </button>
            </div>
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
              SMTP credentials for outbound email alerts. Settings auto-save when you leave a field.
            </p>

            <SmtpForm smtp={smtp} setSmtp={setSmtp} persist={persistSmtp} />
          </>
        )}
      </div>

      {/* ── Feedback Webhooks ───────────────────────────────────── */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          <Webhook size={16} color="var(--text-muted)" /> Feedback Webhooks
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          We POST a JSON body to this URL each time a user submits feedback.
          Works with Slack incoming webhooks, Discord, n8n, Zapier, etc.
          We never send any secrets in the payload.
        </p>

        <label style={LABEL_STYLE}>
          Webhook URL
          <input
            type="text"
            value={webhookUrl}
            onChange={e => setWebhookUrl(e.target.value)}
            onBlur={persistWebhook}
            placeholder="https://hooks.slack.com/services/..."
            className="font-mono"
            style={INPUT_STYLE}
          />
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <button
            className="btn btn-ghost"
            onClick={sendWebhookTestPing}
            disabled={webhookBusy}
          >
            {webhookBusy
              ? <><Loader2 size={14} className="animate-spin" /> Pinging…</>
              : <><Webhook size={14} /> Send test ping</>}
          </button>
          {webhookResult && (
            <span className="font-mono" style={{
              fontSize: 11,
              color: webhookResult.startsWith('OK') ? 'var(--emerald)' : 'var(--rose)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {webhookResult}
            </span>
          )}
        </div>
      </div>

      {/* ╔══════════════════════════════════════════════════════════════╗ */}
      {/* ║ SECTION: Danger zone                                          ║ */}
      {/* ╚══════════════════════════════════════════════════════════════╝ */}
      <SectionHeading>Danger zone</SectionHeading>

      {/* ── Backend dependencies (unchanged) ────────────────────── */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          <Folder size={16} color="var(--text-muted)" /> Backend dependencies
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
          Remote storage adapters shell out to <span className="font-mono">restic</span> (and optionally <span className="font-mono">rclone</span>).
          The shipped Docker image bundles both. Running the backend outside Docker requires installing them separately.
        </p>
      </div>

      {/* ── Export / Import config ──────────────────────────────── */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          <FileText size={16} color="var(--amber)" /> Export / import config
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          Download a snapshot of all DRK configuration (settings, policies, storage vaults, backup history, audit log)
          that you can restore on a new install. Import overwrites existing config — export first if you want to keep it.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-ghost" onClick={handleExport} disabled={exporting}>
            {exporting
              ? <><Loader2 size={14} className="animate-spin" /> Exporting…</>
              : <><Download size={14} /> Export config</>}
          </button>
          <button className="btn btn-danger" onClick={handleImportFile} disabled={importing}>
            {importing
              ? <><Loader2 size={14} className="animate-spin" /> Importing…</>
              : <><Upload size={14} /> Import config</>}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
        {exportError && (
          <p style={{ fontSize: 12, color: 'var(--rose)', margin: '8px 0 0' }}>{exportError}</p>
        )}
        {importResult && (
          <p style={{ fontSize: 12, color: 'var(--emerald)', margin: '8px 0 0' }}>{importResult}</p>
        )}
        {importError && (
          <p style={{ fontSize: 12, color: 'var(--rose)', margin: '8px 0 0' }}>{importError}</p>
        )}
      </div>

      {/* ── Switch instance ─────────────────────────────────────── */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10 }}>
          <LogOut size={16} color="var(--text-muted)" /> Switch instance
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          Clear the stored API key and return to the connection screen.
          Use this to connect to a different Docker Rescue Kit instance.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setImportWizardOpen(true)}
            title="Open the import wizard to restore config from a JSON export or salvaged SQLite DB"
          >
            <Upload size={14} /> Import config…
          </button>
        </div>
      </div>

      <ImportWizard
        open={importWizardOpen}
        onClose={() => setImportWizardOpen(false)}
        onSuccess={load}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components & shared styles
// ─────────────────────────────────────────────────────────────────────────────

const ROW_DT: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 3,
}

const ROW_DD: React.CSSProperties = {
  fontSize: 12, margin: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: 'var(--text-primary)',
}

const LABEL_STYLE: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  fontSize: 11, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 10,
}

const INPUT_STYLE: React.CSSProperties = {
  background: 'var(--surface-0)',
  border: '1px solid var(--surface-4)',
  borderRadius: 'var(--r-sm)',
  padding: '7px 10px',
  fontSize: 12,
  color: 'var(--text-primary)',
  textTransform: 'none',
  letterSpacing: 'normal',
  width: '100%',
}

interface SmtpFormProps {
  smtp: {
    host: string; port: string; user: string; pass: string; secure: boolean; from: string
  }
  setSmtp: React.Dispatch<React.SetStateAction<SmtpFormProps['smtp']>>
  persist: (key: keyof SmtpFormProps['smtp']) => () => void | Promise<void>
}

const SmtpForm: React.FC<SmtpFormProps> = ({ smtp, setSmtp, persist }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
    <label style={LABEL_STYLE}>
      SMTP host
      <input
        type="text"
        value={smtp.host}
        onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))}
        onBlur={persist('host')}
        placeholder="smtp.example.com"
        className="font-mono"
        style={INPUT_STYLE}
      />
    </label>
    <label style={LABEL_STYLE}>
      Port
      <input
        type="number"
        value={smtp.port}
        onChange={e => setSmtp(s => ({ ...s, port: e.target.value }))}
        onBlur={persist('port')}
        placeholder="587"
        className="font-mono"
        style={INPUT_STYLE}
      />
    </label>
    <label style={LABEL_STYLE}>
      Username
      <input
        type="text"
        value={smtp.user}
        onChange={e => setSmtp(s => ({ ...s, user: e.target.value }))}
        onBlur={persist('user')}
        placeholder="apikey or user@example.com"
        className="font-mono"
        style={INPUT_STYLE}
      />
    </label>
    <label style={LABEL_STYLE}>
      Password
      <input
        type="password"
        value={smtp.pass}
        onChange={e => setSmtp(s => ({ ...s, pass: e.target.value }))}
        onBlur={persist('pass')}
        placeholder="••••••••"
        className="font-mono"
        style={INPUT_STYLE}
      />
    </label>
    <label style={{ ...LABEL_STYLE, gridColumn: '1 / span 2' }}>
      From address
      <input
        type="text"
        value={smtp.from}
        onChange={e => setSmtp(s => ({ ...s, from: e.target.value }))}
        onBlur={persist('from')}
        placeholder="DockerRescueKit <noreply@example.com>"
        className="font-mono"
        style={INPUT_STYLE}
      />
    </label>
    <label style={{
      ...LABEL_STYLE,
      gridColumn: '1 / span 2',
      flexDirection: 'row', alignItems: 'center', gap: 8,
      textTransform: 'none', letterSpacing: 'normal',
      fontSize: 13, color: 'var(--text-secondary)',
    }}>
      <input
        type="checkbox"
        checked={smtp.secure}
        onChange={e => {
          const next = e.target.checked
          setSmtp(s => ({ ...s, secure: next }))
          // Fire-and-forget persist on toggle (no blur event for checkboxes).
          persist('secure')()
        }}
      />
      Use TLS (port 465 implicit TLS)
    </label>
  </div>
)
