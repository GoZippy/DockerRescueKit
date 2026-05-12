import React from 'react'
import { AlertCircle, KeyRound, RefreshCw, WifiOff } from 'lucide-react'

export type PageErrorKind = 'auth' | 'docker-offline' | 'unknown'

interface PageErrorProps {
  kind: PageErrorKind
  /** Optional override for the headline */
  title?: string
  /** Optional override for the body copy */
  message?: string
  /** Retry handler — renders a Retry button when provided */
  onRetry?: () => void
  /** Optional secondary action (e.g. navigate to settings on auth errors) */
  secondaryAction?: { label: string; onClick: () => void }
}

const PRESET: Record<PageErrorKind, { title: string; message: string; iconBg: string; iconColor: string; Icon: React.FC<any> }> = {
  auth: {
    title: 'Invalid API key',
    message: 'The stored API key was rejected by the server. Update it in Settings.',
    iconBg: 'var(--rose-dim)',
    iconColor: 'var(--rose)',
    Icon: KeyRound,
  },
  'docker-offline': {
    title: 'Docker daemon offline',
    message: 'The backend cannot reach the Docker daemon. Make sure Docker is running and the socket is mounted.',
    iconBg: 'var(--amber-dim)',
    iconColor: 'var(--amber)',
    Icon: WifiOff,
  },
  unknown: {
    title: 'Something went wrong',
    message: 'An unexpected error occurred. Check the backend logs for details.',
    iconBg: 'var(--rose-dim)',
    iconColor: 'var(--rose)',
    Icon: AlertCircle,
  },
}

export const PageError: React.FC<PageErrorProps> = ({ kind, title, message, onRetry, secondaryAction }) => {
  const preset = PRESET[kind]
  const Icon = preset.Icon
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: 300, gap: 16, textAlign: 'center',
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 12,
        background: preset.iconBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={24} color={preset.iconColor} />
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{title ?? preset.title}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 320 }}>
          {message ?? preset.message}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {secondaryAction && (
          <button className="btn btn-primary" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </button>
        )}
        {onRetry && (
          <button className={secondaryAction ? 'btn btn-ghost' : 'btn btn-primary'} onClick={onRetry}>
            <RefreshCw size={14} /> Retry
          </button>
        )}
      </div>
    </div>
  )
}
