import React, { useEffect, useRef, useState } from 'react'
import { Info, ExternalLink, Settings as SettingsIcon, Tag, GitBranch } from 'lucide-react'
import { getSettingsMeta } from '../api'

const REPO_URL = 'https://github.com/gozippy/DockerRescueKit'
const RELEASES_URL = `${REPO_URL}/releases`
const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`
const DOCKER_HUB_TAGS = 'https://hub.docker.com/r/gozippy/dockerrescuekit/tags'

interface VersionBadgeProps {
  onOpenSettings?: () => void
  compact?: boolean
}

export const VersionBadge: React.FC<VersionBadgeProps> = ({ onOpenSettings, compact }) => {
  const [version, setVersion] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    getSettingsMeta()
      .then(m => { if (!cancelled) setVersion(m?.version ?? null) })
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

  if (!version && !open) {
    // No version available yet — render an invisible placeholder so layout doesn't jump.
    return <div style={{ height: compact ? 28 : 30 }} aria-hidden />
  }

  const label = version ? `v${version}` : 'v?'

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
            minWidth: 200,
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
            <span style={{ fontSize: 11, color: 'var(--text-muted, #64748b)', fontFamily: 'var(--font-mono, monospace)' }}>
              {label}
            </span>
          </div>

          <PopoverLink href={RELEASES_URL} icon={<ExternalLink size={12} />}>
            Release notes
          </PopoverLink>
          <PopoverLink href={CHANGELOG_URL} icon={<ExternalLink size={12} />}>
            Changelog
          </PopoverLink>
          <PopoverLink href={DOCKER_HUB_TAGS} icon={<ExternalLink size={12} />}>
            All versions
          </PopoverLink>

          {onOpenSettings && (
            <button
              type="button"
              onClick={() => { setOpen(false); onOpenSettings() }}
              style={{
                ...rowStyle,
                width: '100%',
                cursor: 'pointer',
                border: 'none',
                textAlign: 'left',
                background: 'transparent',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-3, rgba(255,255,255,0.05))' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <SettingsIcon size={12} />
              <span style={{ flex: 1 }}>Open Settings</span>
            </button>
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

const PopoverLink: React.FC<{ href: string; icon: React.ReactNode; children: React.ReactNode }> = ({ href, icon, children }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    style={rowStyle}
    onMouseEnter={e => {
      e.currentTarget.style.background = 'var(--surface-3, rgba(255,255,255,0.05))'
      e.currentTarget.style.color = 'var(--text-primary, #e2e8f0)'
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = 'transparent'
      e.currentTarget.style.color = 'var(--text-secondary, #94a3b8)'
    }}
  >
    {icon}
    <span style={{ flex: 1 }}>{children}</span>
  </a>
)
