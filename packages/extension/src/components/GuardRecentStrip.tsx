/**
 * GuardRecentStrip — "Recently saved" section for the Dashboard.
 *
 * Fetches the 5 most recent guard events with status=saved and renders them
 * as compact cards. If no events exist (or the backend returns 404 because
 * PG-1.4 isn't deployed yet) it renders nothing — zero empty-state noise.
 *
 * Per §10.3: no "prune" / "tarball" in primary copy; leads with reassurance;
 * one primary action button (Undo), everything else secondary.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Pin, Clock, ShieldCheck } from 'lucide-react'
import { GuardEvent } from '@docker-rescue-kit/shared'
import { listGuardEvents, restoreGuardEvent, pinGuardEvent } from '../api'
import { useToast } from '../hooks/useToast'

const fmt = (bytes: number) => {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

const ago = (ts: string) => {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const OP_LABEL: Record<string, string> = {
  volume_rm:      'volume removed',
  volume_prune:   'cleanup',
  container_rm_v: 'container removed',
  system_prune:   'system cleanup',
  image_prune:    'image cleanup',
  compose_down_v: 'stack shutdown',
  container_die:  'container stopped',
  periodic_floor: 'scheduled snapshot',
}

interface EventCardProps {
  event: GuardEvent
  onRefresh: () => void
}

const EventCard: React.FC<EventCardProps> = ({ event, onRefresh }) => {
  const toast = useToast()
  const [busy, setBusy] = useState<'restore' | 'pin' | null>(null)

  const savedVols = event.volumes.filter(v => v.status === 'saved')
  const volNames = savedVols.map(v => v.volume)

  const handleRestore = async () => {
    setBusy('restore')
    try {
      const res = await restoreGuardEvent(event.id)
      const count = res.restored?.length ?? 0
      toast.push(
        'success',
        `Restored ${count} ${count === 1 ? 'volume' : 'volumes'}. Re-create the containers to use them.`,
        7000,
      )
      onRefresh()
    } catch {
      toast.push('error', 'Restore failed — see the backend logs for details.')
    } finally {
      setBusy(null)
    }
  }

  const handlePin = async () => {
    setBusy('pin')
    try {
      await pinGuardEvent(event.id)
      toast.push('success', 'Saved as a backup. You can restore it any time from your backup history.')
      onRefresh()
    } catch {
      toast.push('error', 'Could not save as backup — see the backend logs.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        minWidth: 220,
        flexShrink: 0,
        background: event.status === 'restored' ? 'var(--surface-3)' : 'var(--surface-2)',
      }}
    >
      {/* Kind + age */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
        <span className="badge badge-info" style={{ fontSize: 10 }}>
          {OP_LABEL[event.kind] ?? event.kind}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Clock size={10} />
          {ago(event.createdAt)}
        </span>
      </div>

      {/* Volume list */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {volNames.slice(0, 3).map(v => (
          <code
            key={v}
            style={{
              fontSize: 10, background: 'var(--surface-3)', padding: '1px 6px',
              borderRadius: 3, color: 'var(--text-secondary)', whiteSpace: 'nowrap',
            }}
          >
            {v}
          </code>
        ))}
        {volNames.length > 3 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>+{volNames.length - 3} more</span>
        )}
      </div>

      {/* Size */}
      {event.totalBytes > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {fmt(event.totalBytes)} saved
        </div>
      )}

      {/* Actions — disabled if already restored */}
      {event.status !== 'restored' && event.status !== 'expired' && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn btn-primary"
            style={{ fontSize: 11, padding: '4px 10px', flex: 1 }}
            disabled={busy !== null}
            onClick={handleRestore}
            aria-label={`Undo — restore ${volNames.join(', ')}`}
          >
            <RotateCcw size={11} />
            {busy === 'restore' ? 'Restoring…' : 'Undo'}
          </button>
          {!event.pinned && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: '4px 10px' }}
              disabled={busy !== null}
              onClick={handlePin}
              aria-label="Keep as backup"
              title="Keep as backup"
            >
              <Pin size={11} />
            </button>
          )}
        </div>
      )}

      {event.status === 'restored' && (
        <span style={{ fontSize: 11, color: 'var(--emerald)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ShieldCheck size={12} /> Restored
        </span>
      )}
    </div>
  )
}

// ── Main strip ────────────────────────────────────────────────────────────

export const GuardRecentStrip: React.FC = () => {
  const [events, setEvents] = useState<GuardEvent[]>([])
  // null = not yet loaded; false = feature unavailable (404)
  const [available, setAvailable] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    try {
      const evts = await listGuardEvents({ limit: 5, status: 'saved' })
      setEvents(evts)
      setAvailable(true)
    } catch (e: any) {
      // 404 → backend not deployed yet; hide silently
      if (e?.response?.status === 404 || e?.status === 404) {
        setAvailable(false)
        return
      }
      // Any other error: treat as unavailable (no spam)
      setAvailable(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Hide if feature not available or no events
  if (available === false || (available === true && events.length === 0)) return null
  if (available === null) return null

  return (
    <div
      className="card"
      style={{ padding: 0, overflow: 'hidden' }}
      aria-label="Recently saved snapshots"
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 16px',
        borderBottom: '1px solid var(--surface-4)',
      }}>
        <ShieldCheck size={14} color="var(--emerald)" />
        <span style={{ fontWeight: 700, fontSize: 13 }}>Recently saved</span>
        <span
          className="badge badge-success"
          style={{ marginLeft: 'auto', fontSize: 10 }}
        >
          {events.length}
        </span>
      </div>

      {/* Horizontally scrollable card row */}
      <div style={{
        display: 'flex',
        gap: 10,
        padding: '10px 14px',
        overflowX: 'auto',
        alignItems: 'stretch',
      }}>
        {events.map(ev => (
          <EventCard key={ev.id} event={ev} onRefresh={load} />
        ))}
      </div>
    </div>
  )
}
