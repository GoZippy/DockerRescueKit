/**
 * GuardToast — action-capable guard-event banner.
 *
 * Lives OUTSIDE the existing Toast system because guard toasts carry multiple
 * action buttons (Undo / Keep as backup / Dismiss) and must persist until the
 * user acts or dismisses them — neither of which the simple auto-timeout
 * ToastRow supports.
 *
 * Mount once at the app root (inside <ToastProvider> so child actions can
 * push plain success/error toasts via useToast). State is managed by the
 * useGuardStream hook which passes pending banners down here.
 */
import React, { useEffect, useState } from 'react'
import { ShieldCheck, RotateCcw, Pin, X, AlertTriangle } from 'lucide-react'
import { GuardEvent } from '@docker-rescue-kit/shared'
import { restoreGuardEvent, pinGuardEvent } from '../api'
import { useToast } from '../hooks/useToast'

// ── Frame shapes coming off /api/guard/stream ────────────────────────────

export interface GuardSnapshotFrame {
  kind: 'snapshot'
  id: string
  opKind: GuardEvent['kind']
  volumes: Array<{ volume: string; sizeBytes: number }>
}

export interface GuardTooLateFrame {
  kind: 'too_late'
  id: string
  volume: string
  floorSnapshotAgeHours: number
}

export type GuardFrame = GuardSnapshotFrame | GuardTooLateFrame

// ── Single banner ─────────────────────────────────────────────────────────

interface BannerProps {
  frame: GuardFrame
  onDismiss: (id: string) => void
}

const fmt = (bytes: number) => {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

const GuardBanner: React.FC<BannerProps> = ({ frame, onDismiss }) => {
  const toast = useToast()
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState<'restore' | 'pin' | null>(null)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const dismiss = () => {
    setLeaving(true)
    window.setTimeout(() => onDismiss(frame.id), 240)
  }

  const handleRestore = async () => {
    setBusy('restore')
    try {
      const res = await restoreGuardEvent(frame.id)
      const count = res.restored?.length ?? 0
      dismiss()
      toast.push(
        'success',
        `Restored ${count} ${count === 1 ? 'volume' : 'volumes'}. Re-create the containers to use them.`,
        7000,
      )
    } catch {
      toast.push('error', 'Restore failed — see the backend logs for details.')
    } finally {
      setBusy(null)
    }
  }

  const handlePin = async () => {
    setBusy('pin')
    try {
      await pinGuardEvent(frame.id)
      dismiss()
      toast.push('success', 'Saved as a backup. You can restore it any time from your backup history.')
    } catch {
      toast.push('error', 'Could not save as backup — see the backend logs.')
    } finally {
      setBusy(null)
    }
  }

  // ── snapshot variant ─────────────────────────────────────────────────────
  if (frame.kind === 'snapshot') {
    const volNames = frame.volumes.map(v => v.volume)
    const totalBytes = frame.volumes.reduce((a, v) => a + (v.sizeBytes ?? 0), 0)
    const volList = volNames.slice(0, 3).map(v => (
      <code key={v} style={{ fontSize: 11, background: 'var(--surface-3)', padding: '1px 5px', borderRadius: 3, whiteSpace: 'nowrap' }}>
        {v}
      </code>
    ))
    const overflow = volNames.length > 3 ? ` +${volNames.length - 3} more` : ''

    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '14px 16px',
          background: 'var(--surface-2)',
          border: '1px solid rgba(16,185,129,0.35)',
          borderLeft: '3px solid var(--emerald)',
          borderRadius: 'var(--r-md)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
          minWidth: 300,
          maxWidth: 420,
          transform: visible && !leaving ? 'translateX(0)' : 'translateX(120%)',
          opacity: visible && !leaving ? 1 : 0,
          transition: 'transform 0.24s ease, opacity 0.24s ease',
        }}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 6, flexShrink: 0,
            background: 'var(--emerald-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <ShieldCheck size={16} color="var(--emerald)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3, color: 'var(--text-primary)', marginBottom: 3 }}>
              We saved your work before that cleanup.
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                {volList}
                {overflow && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{overflow}</span>}
                {totalBytes > 0 && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>· {fmt(totalBytes)}</span>
                )}
              </span>
            </div>
          </div>
          <button
            className="btn-icon"
            onClick={dismiss}
            aria-label="Dismiss guard notification"
            style={{ flexShrink: 0, padding: 4 }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Action row */}
        <div style={{ display: 'flex', gap: 6, paddingLeft: 40 }}>
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, padding: '5px 12px' }}
            disabled={busy !== null}
            onClick={handleRestore}
            aria-label="Undo — restore saved volumes now"
          >
            <RotateCcw size={12} />
            {busy === 'restore' ? 'Restoring…' : 'Undo — restore now'}
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '5px 12px' }}
            disabled={busy !== null}
            onClick={handlePin}
            aria-label="Keep as backup"
          >
            <Pin size={12} />
            {busy === 'pin' ? 'Saving…' : 'Keep as backup'}
          </button>
        </div>
      </div>
    )
  }

  // ── too_late variant ─────────────────────────────────────────────────────
  const ageH = frame.floorSnapshotAgeHours
  const ageLabel = ageH < 1
    ? 'less than an hour'
    : ageH === 1
    ? '1 hour'
    : `${Math.round(ageH)} hours`

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        background: 'var(--surface-2)',
        border: '1px solid rgba(245,158,11,0.35)',
        borderLeft: '3px solid var(--amber)',
        borderRadius: 'var(--r-md)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
        minWidth: 300,
        maxWidth: 420,
        transform: visible && !leaving ? 'translateX(0)' : 'translateX(120%)',
        opacity: visible && !leaving ? 1 : 0,
        transition: 'transform 0.24s ease, opacity 0.24s ease',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 6, flexShrink: 0,
          background: 'var(--amber-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <AlertTriangle size={16} color="var(--amber)" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3, color: 'var(--text-primary)', marginBottom: 3 }}>
            <code style={{ fontSize: 12, background: 'var(--surface-3)', padding: '1px 5px', borderRadius: 3 }}>
              {frame.volume}
            </code>{' '}was deleted.
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            DRK couldn&apos;t save a copy in time, but your last automatic
            snapshot is <strong>{ageLabel} old</strong>. You can still recover from it.
          </div>
        </div>
        <button
          className="btn-icon"
          onClick={dismiss}
          aria-label="Dismiss guard notification"
          style={{ flexShrink: 0, padding: 4 }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Action row */}
      <div style={{ paddingLeft: 40 }}>
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, padding: '5px 12px' }}
          disabled={busy !== null}
          onClick={handleRestore}
          aria-label="Restore that snapshot"
        >
          <RotateCcw size={12} />
          {busy === 'restore' ? 'Restoring…' : 'Restore that snapshot'}
        </button>
      </div>
    </div>
  )
}

// ── Container (renders all pending banners) ───────────────────────────────

interface GuardToastContainerProps {
  frames: GuardFrame[]
  onDismiss: (id: string) => void
}

export const GuardToastContainer: React.FC<GuardToastContainerProps> = ({ frames, onDismiss }) => {
  if (frames.length === 0) return null
  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 80,   /* above the plain Toast layer at bottom:16 + heights */
        zIndex: 1010,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {frames.map(f => (
        <div key={f.id} style={{ pointerEvents: 'auto' }}>
          <GuardBanner frame={f} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  )
}
