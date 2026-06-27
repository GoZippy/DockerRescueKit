/**
 * PruneGuardPage — the discoverable home for Prune Guard ("Undo for Docker").
 *
 * Prune Guard auto-snapshots volumes BEFORE a destructive Docker operation
 * (an AI coding agent, `docker system prune`, `compose down -v`) so the change
 * can be rolled back. Previously it was only reachable as two Dashboard widgets
 * that render nothing when the feature is off (DRK_PRUNE_GUARD unset) — so most
 * users never discovered it. This page surfaces the value prop *always*, and:
 *   - when the feature is reachable → shows the live settings + recently-saved
 *   - when it's off (404)           → shows a clear "how to enable" card
 */
import React, { useEffect, useState } from 'react'
import { RotateCcw, ShieldCheck, Bot, Trash2, Power, AlertTriangle, type LucideIcon } from 'lucide-react'
import { getGuardSettings } from '../api'
import { GuardSettingsCard } from './GuardSettingsCard'
import { GuardRecentStrip } from './GuardRecentStrip'

type Avail = 'loading' | 'available' | 'unavailable'

const THREATS: Array<{ icon: LucideIcon; text: string }> = [
  { icon: Bot, text: 'An AI coding agent that ignores prompts and denylists' },
  { icon: Trash2, text: 'docker system prune / docker volume prune' },
  { icon: Power, text: 'docker compose down -v (volumes wiped on teardown)' },
]

const codeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 12,
  background: 'var(--surface-3)',
  borderRadius: 4,
  padding: '1px 6px',
  color: 'var(--text-primary)',
}

export const PruneGuardPage: React.FC = () => {
  const [avail, setAvail] = useState<Avail>('loading')

  useEffect(() => {
    let alive = true
    // getGuardSettings throws 404 when DRK_PRUNE_GUARD is unset (feature off).
    getGuardSettings()
      .then(() => { if (alive) setAvail('available') })
      .catch(() => { if (alive) setAvail('unavailable') })
    return () => { alive = false }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 780 }}>
      {/* ── Hero: the "Undo for Docker" value prop, always visible ───────── */}
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: 'var(--emerald-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <RotateCcw size={20} color="var(--emerald)" />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
              Undo for Docker
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
              Prune Guard — a free safety net for your volume data
            </p>
          </div>
        </div>

        <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          DRK quietly saves a copy of your Docker volumes <strong>before</strong> anything destructive
          touches them, so you can roll back with one click. Prompts and denylists can be bypassed —
          a backup taken first can&apos;t be.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Protects against
          </div>
          {THREATS.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
              <t.icon size={15} color="var(--text-muted)" style={{ flexShrink: 0 }} />
              <span>{t.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Loading ───────────────────────────────────────────────────── */}
      {avail === 'loading' && (
        <div className="card" style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
          Checking Prune Guard status…
        </div>
      )}

      {/* ── Available: the real settings + recently-saved widgets ───────── */}
      {avail === 'available' && (
        <>
          <GuardSettingsCard />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 12px', fontSize: 14, fontWeight: 700 }}>
              <ShieldCheck size={16} color="var(--emerald)" />
              Recently saved
            </div>
            <GuardRecentStrip />
          </div>
        </>
      )}

      {/* ── Unavailable (flag off): how to enable, instead of a blank page ─ */}
      {avail === 'unavailable' && (
        <div className="card" style={{ padding: 20, borderColor: 'var(--amber)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <AlertTriangle size={18} color="var(--amber)" />
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Prune Guard isn&apos;t enabled yet</h3>
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
            It ships behind a kill-switch while it&apos;s experimental. To turn it on, set{' '}
            <code style={codeStyle}>DRK_PRUNE_GUARD=1</code> on the DockerRescueKit container and
            restart it:
          </p>
          <pre style={{
            margin: 0,
            padding: '12px 14px',
            background: 'var(--surface-0)',
            border: '1px solid var(--surface-4)',
            borderRadius: 'var(--r-md)',
            fontSize: 12,
            lineHeight: 1.6,
            overflowX: 'auto',
            color: 'var(--text-secondary)',
          }}>{`services:
  drk:
    image: gozippy/dockerrescuekit
    environment:
      - DRK_PRUNE_GUARD=1`}</pre>
          <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            After it restarts, refresh — your settings and saved copies will appear here.
          </p>
        </div>
      )}
    </div>
  )
}
