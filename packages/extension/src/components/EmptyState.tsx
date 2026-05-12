import React from 'react'

interface EmptyStateProps {
  icon: React.ReactNode
  title: string
  description: string
  action?: {
    label: string
    onClick: () => void
  }
}

/**
 * Shared empty-state component.
 *
 * Centered layout with a soft-tinted icon background, a title in the primary
 * text color, a longer description in the secondary text color, and an
 * optional primary CTA button.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
}) => {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '40px 24px',
        gap: 14,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: 'var(--surface-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-secondary)',
        }}
      >
        {icon}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--text-primary)',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
      </div>

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          aria-label={action.label}
          style={{
            marginTop: 4,
            padding: '8px 16px',
            background: 'var(--blue-500)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--r-md)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--blue-600)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--blue-500)' }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
