import React from 'react'
import { AlertTriangle, Download, ExternalLink, X, Loader2 } from 'lucide-react'
import { formatDistanceToNowStrict } from 'date-fns'
import { openExternal } from '../utils/openExternal'

const UPGRADE_GUIDE_URL =
  'https://github.com/gozippy/DockerRescueKit/blob/main/docs/UPGRADE.md'

export interface UpgradeBannerProps {
  /** ISO timestamp of the last successful config export (latest-bootstrap.json mtime). */
  lastExportAt?: string
  /** Triggered when the user clicks "Export now". */
  onExportNow: () => void | Promise<void>
  /** Dismisses the banner for the current session only (NOT persisted). */
  onDismiss: () => void
  /** Optional flag to show a spinner on the Export button while a parent-owned export is in flight. */
  exporting?: boolean
}

/**
 * Sticky data-safety banner shown at the top of the Settings page.
 *
 * Reminds the user to export their config before any upgrade or reinstall —
 * Docker Desktop deletes the extension's data volume when it's removed or its
 * image ID changes, so an un-exported install is one `docker extension rm`
 * away from total data loss.
 *
 * Visual style matches the in-page amber alert callout already used elsewhere
 * in SettingsPage (Update-available callout, API-key warning) so it feels
 * native to the surrounding UI.
 */
export const UpgradeBanner: React.FC<UpgradeBannerProps> = ({
  lastExportAt,
  onExportNow,
  onDismiss,
  exporting,
}) => {
  const lastExportLabel = (() => {
    if (!lastExportAt) return 'never'
    const t = Date.parse(lastExportAt)
    if (!Number.isFinite(t)) return 'never'
    try {
      return `${formatDistanceToNowStrict(new Date(t))} ago`
    } catch {
      return 'never'
    }
  })()

  return (
    <div
      role="region"
      aria-label="Data-safety reminder: export your config before upgrading"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 5,
        marginBottom: 16,
        background: 'var(--amber-dim)',
        border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 'var(--r-md)',
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        // A subtle shadow + opaque-ish backdrop keeps the banner legible
        // when content scrolls behind it.
        boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <AlertTriangle
        size={18}
        color="#fbbf24"
        style={{ flexShrink: 0, marginTop: 2 }}
        aria-hidden
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--text-secondary)',
          }}
        >
          <strong style={{ color: '#fbbf24' }}>
            Before any upgrade or reinstall, export your config.
          </strong>{' '}
          Docker Desktop deletes your data volume when an extension is removed
          or its image ID changes. Your last export was{' '}
          <span
            className="font-mono"
            style={{
              color: lastExportAt ? 'var(--text-primary)' : 'var(--rose)',
              fontWeight: 600,
            }}
          >
            {lastExportLabel}
          </span>
          .
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 10,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onExportNow()}
            disabled={exporting}
          >
            {exporting ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Exporting…
              </>
            ) : (
              <>
                <Download size={14} /> Export now
              </>
            )}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => openExternal(UPGRADE_GUIDE_URL)}
          >
            <ExternalLink size={14} /> Read upgrade guide
          </button>
        </div>
      </div>

      <button
        type="button"
        className="btn-icon"
        onClick={onDismiss}
        title="Dismiss for this session"
        aria-label="Dismiss for this session"
        style={{
          flexShrink: 0,
          color: 'var(--text-muted)',
          marginTop: -2,
        }}
      >
        <X size={16} />
      </button>
    </div>
  )
}
