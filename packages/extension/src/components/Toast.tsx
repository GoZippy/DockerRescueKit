import React, { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: string
  kind: ToastKind
  message: string
  timeout?: number
}

interface ToastProps {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}

const KIND_STYLE: Record<ToastKind, { bg: string; border: string; color: string; Icon: React.FC<any> }> = {
  success: { bg: 'var(--emerald-dim)', border: 'rgba(16,185,129,0.35)', color: '#34d399', Icon: CheckCircle2 },
  error:   { bg: 'var(--rose-dim)',    border: 'rgba(244,63,94,0.35)',  color: '#fb7185', Icon: AlertCircle },
  warning: { bg: 'var(--amber-dim)',   border: 'rgba(245,158,11,0.35)', color: '#fbbf24', Icon: AlertTriangle },
  info:    { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)', color: 'var(--blue-500)', Icon: Info },
}

/* ── Single toast row ─────────────────────────────────────── */
const ToastRow: React.FC<{ toast: ToastItem; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const style = KIND_STYLE[toast.kind]
  const Icon = style.Icon

  useEffect(() => {
    // Trigger slide-in on mount
    const t = requestAnimationFrame(() => setVisible(true))
    const timeout = window.setTimeout(() => {
      setLeaving(true)
      window.setTimeout(() => onDismiss(toast.id), 220)
    }, toast.timeout ?? 4000)
    return () => {
      cancelAnimationFrame(t)
      window.clearTimeout(timeout)
    }
  }, [toast.id, toast.timeout, onDismiss])

  const handleClick = () => {
    setLeaving(true)
    window.setTimeout(() => onDismiss(toast.id), 220)
  }

  return (
    <div
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 14px',
        background: 'var(--surface-2)',
        border: `1px solid ${style.border}`,
        borderLeft: `3px solid ${style.color}`,
        borderRadius: 'var(--r-md)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        minWidth: 280,
        maxWidth: 380,
        cursor: 'pointer',
        transform: visible && !leaving ? 'translateX(0)' : 'translateX(120%)',
        opacity: visible && !leaving ? 1 : 0,
        transition: 'transform 0.22s ease, opacity 0.22s ease',
      }}
      title="Click to dismiss"
    >
      <div style={{
        width: 28, height: 28, borderRadius: 6, flexShrink: 0,
        background: style.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={16} color={style.color} />
      </div>
      <div style={{
        flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4,
        color: 'var(--text-primary)', wordBreak: 'break-word',
      }}>
        {toast.message}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); handleClick() }}
        style={{
          background: 'none', border: 'none', padding: 2, cursor: 'pointer',
          color: 'var(--text-muted)', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}

/* ── Toast container ──────────────────────────────────────── */
export const Toast: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map(t => (
        <div key={t.id} style={{ pointerEvents: 'auto' }}>
          <ToastRow toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  )
}
