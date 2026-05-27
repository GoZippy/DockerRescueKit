import React, { useEffect, useRef, useState } from 'react'
import {
  Info, ExternalLink, Settings as SettingsIcon, Tag, GitBranch,
  RefreshCw, Download, ClipboardCopy, MessageSquarePlus, Check,
  AlertCircle, Loader2,
} from 'lucide-react'
import { getSettingsMeta, checkVersion } from '../api'
import { openExternal, openMarketplace } from '../utils/openExternal'

const REPO_URL = 'https://github.com/gozippy/DockerRescueKit'
const RELEASES_URL = `${REPO_URL}/releases`
const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`
const DOCKER_HUB_TAGS = 'https://hub.docker.com/r/gozippy/dockerrescuekit/tags'

interface VersionBadgeProps {
  onOpenSettings?: () => void
  onOpenFeedback?: () => void
  compact?: boolean
}

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; latest: string }
  | { kind: 'available'; latest: string }
  | { kind: 'error'; message: string }

export const VersionBadge: React.FC<VersionBadgeProps> = ({
  onOpenSettings, onOpenFeedback, compact,
}) => {
  const [version, setVersion] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ dataDir?: string; staging?: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Load version once at mount — best-effort.
  useEffect(() => {
    let cancelled = false
    getSettingsMeta()
      .then(m => {
        if (cancelled) return
        setVersion(m?.version ?? null)
        setMeta({ dataDir: m?.dataDir, staging: m?.staging })
      })
      .catch(() => { /* silent — version label is best-effort */ })
    return () => { cancelled = true }
  }, [])

  // Close on outside click + Escape
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const runUpdateCheck = async () => {
    setUpdateState({ kind: 'checking' })
    try {
      const res = await checkVersion()
      if (res.hubError) {
        setUpdateState({ kind: 'error', message: res.hubError })
        return
      }
      if (res.updateAvailable && res.latest) {
        setUpdateState({ kind: 'available', latest: res.latest })
      } else if (res.latest) {
        setUpdateState({ kind: 'current', latest: res.latest })
      } else {
        setUpdateState({ kind: 'error', message: 'No latest version returned' })
      }
    } catch (e: any) {
      setUpdateState({ kind: 'error', message: e?.message || 'Check failed' })
    }
  }

  const copyDiagnostics = async () => {
    const lines = [
      `DockerRescueKit ${version ? 'v' + version : '(version unknown)'}`,
      `Transport: ${import.meta.env.VITE_TRANSPORT || 'tcp'}`,
      `User-Agent: ${navigator.userAgent}`,
      `Data dir: ${meta?.dataDir || '(unknown)'}`,
      `Staging: ${meta?.staging || '(unknown)'}`,
      `Captured at: ${new Date().toISOString()}`,
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard blocked — show toast-like fallback by appending to URL or window prompt
      window.prompt('Copy diagnostics manually:', lines.join('\n'))
    }
  }

  if (!version && !open) {
    return <div style={{ height: compact ? 28 : 30 }} aria-hidden />
  }

  const label = version ? `v${version}` : 'v?'
  const checking = updateState.kind === 'checking'

  return (
    <div ref={wrapRef} style={{ position: 'relative', padding: '0 8px 8px' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`DockerRescueKit ${label} — version info`}
        title={`DockerRescueKit ${label}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: compact ? '4px 8px' : '6px 10px',
          fontSize: 11,
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          color: 'var(--text-muted, #64748b)',
          background: 'transparent',
          border: '1px solid var(--surface-4, rgba(255,255,255,0.06))',
          borderRadius: 6,
          cursor: 'pointer',
          transition: 'background 0.15s, color 0.15s, border-color 0.15s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'var(--surface-2, rgba(255,255,255,0.04))'
          e.currentTarget.style.color = 'var(--text-secondary, #94a3b8)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = 'var(--text-muted, #64748b)'
        }}
      >
        <Tag size={11} />
        <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
        {updateState.kind === 'available' && (
          <span
            aria-label="Update available"
            title={`Update available: v${updateState.latest}`}
            style={{
              width: 7, height: 7, borderRadius: '50%',
              background: 'var(--amber, #f59e0b)',
            }}
          />
        )}
        <Info size={11} style={{ opacity: 0.6 }} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Version info"
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 'calc(100% + 4px)',
            background: 'var(--surface-1, #0f172a)',
            border: '1px solid var(--surface-4, rgba(255,255,255,0.08))',
            borderRadius: 8,
            padding: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            zIndex: 30,
            minWidth: 240,
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 8px 8px',
            borderBottom: '1px solid var(--surface-4, rgba(255,255,255,0.06))',
            marginBottom: 4,
          }}>
            <GitBranch size={12} style={{ color: 'var(--blue-500, #3b82f6)', flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary, #e2e8f0)' }}>
              DockerRescueKit
            </span>
            <span style={{
              fontSize: 11, color: 'var(--text-muted, #64748b)',
              fontFamily: 'var(--font-mono, monospace)', marginLeft: 'auto',
            }}>
              {label}
            </span>
          </div>

          {/* Update status pane — only render when something happened */}
          {updateState.kind !== 'idle' && (
            <div style={{
              padding: '8px 8px 10px',
              margin: '0 0 6px',
              borderBottom: '1px solid var(--surface-4, rgba(255,255,255,0.06))',
              fontSize: 11.5,
              color: 'var(--text-secondary, #94a3b8)',
            }}>
              {updateState.kind === 'checking' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Loader2 size={12} className="animate-spin" /> Checking Docker Hub…
                </span>
              )}
              {updateState.kind === 'current' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--emerald, #10b981)' }}>
                  <Check size={12} /> You're on the latest (v{updateState.latest})
                </span>
              )}
              {updateState.kind === 'available' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--amber, #f59e0b)' }}>
                    <Download size={12} /> Update available: v{updateState.latest}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setOpen(false); openMarketplace() }}
                    style={{
                      ...rowStyle,
                      width: '100%',
                      cursor: 'pointer',
                      border: '1px solid var(--blue-500, #3b82f6)',
                      background: 'rgba(59,130,246,0.10)',
                      color: 'var(--blue-500, #3b82f6)',
                      justifyContent: 'center',
                      padding: '7px 10px',
                    }}
                  >
                    <Download size={12} />
                    <span style={{ flex: 'unset' }}>Open Marketplace to update</span>
                  </button>
                </div>
              )}
              {updateState.kind === 'error' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--rose, #f43f5e)' }}>
                  <AlertCircle size={12} /> {updateState.message}
                </span>
              )}
            </div>
          )}

          {/* Action rows */}
          <PopoverButton
            icon={<RefreshCw size={12} className={checking ? 'animate-spin' : undefined} />}
            onClick={runUpdateCheck}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </PopoverButton>

          <PopoverButton
            icon={<Download size={12} />}
            onClick={() => { setOpen(false); openMarketplace() }}
          >
            Open Marketplace
          </PopoverButton>

          <div style={dividerStyle} />

          <PopoverButton
            icon={<ExternalLink size={12} />}
            onClick={() => { setOpen(false); openExternal(RELEASES_URL) }}
          >
            Release notes
          </PopoverButton>
          <PopoverButton
            icon={<ExternalLink size={12} />}
            onClick={() => { setOpen(false); openExternal(CHANGELOG_URL) }}
          >
            Changelog
          </PopoverButton>
          <PopoverButton
            icon={<ExternalLink size={12} />}
            onClick={() => { setOpen(false); openExternal(DOCKER_HUB_TAGS) }}
          >
            All versions
          </PopoverButton>

          <div style={dividerStyle} />

          <PopoverButton
            icon={copied ? <Check size={12} color="var(--emerald, #10b981)" /> : <ClipboardCopy size={12} />}
            onClick={copyDiagnostics}
          >
            {copied ? 'Copied diagnostics' : 'Copy diagnostics'}
          </PopoverButton>

          {onOpenFeedback && (
            <PopoverButton
              icon={<MessageSquarePlus size={12} />}
              onClick={() => { setOpen(false); onOpenFeedback() }}
            >
              Send feedback
            </PopoverButton>
          )}

          {onOpenSettings && (
            <PopoverButton
              icon={<SettingsIcon size={12} />}
              onClick={() => { setOpen(false); onOpenSettings() }}
            >
              Open Settings
            </PopoverButton>
          )}
        </div>
      )}
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 8px',
  fontSize: 12,
  color: 'var(--text-secondary, #94a3b8)',
  borderRadius: 4,
  textDecoration: 'none',
  transition: 'background 0.15s, color 0.15s',
}

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: 'var(--surface-4, rgba(255,255,255,0.06))',
  margin: '4px 0',
}

const PopoverButton: React.FC<{
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}> = ({ icon, onClick, disabled, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    style={{
      ...rowStyle,
      width: '100%',
      cursor: disabled ? 'not-allowed' : 'pointer',
      border: 'none',
      textAlign: 'left',
      background: 'transparent',
      opacity: disabled ? 0.6 : 1,
    }}
    onMouseEnter={e => {
      if (!disabled) e.currentTarget.style.background = 'var(--surface-3, rgba(255,255,255,0.05))'
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = 'transparent'
    }}
  >
    {icon}
    <span style={{ flex: 1 }}>{children}</span>
  </button>
)
