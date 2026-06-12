import React, { useState } from 'react'
import { ChevronDown, ChevronRight, HelpCircle } from 'lucide-react'

interface HelpDisclosureProps {
  /** The clickable summary line. */
  title: string
  /** Optional leading icon; defaults to a help circle. */
  icon?: React.ReactNode
  /** Start expanded? Default collapsed so it never crowds the UI. */
  defaultOpen?: boolean
  /** Smaller, quieter styling for inline use inside cards. */
  compact?: boolean
  children: React.ReactNode
}

/**
 * A collapsed-by-default "Learn more" disclosure. Deliberately low-contrast and
 * out of the way so power users ignore it, while newcomers can expand it for
 * context. Accessible: real <button> with aria-expanded driving a region.
 */
export const HelpDisclosure: React.FC<HelpDisclosureProps> = ({
  title, icon, defaultOpen = false, compact = false, children,
}) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      style={{
        border: '1px solid var(--surface-4, rgba(255,255,255,0.06))',
        borderRadius: 'var(--r-md, 8px)',
        background: 'var(--surface-1, #0f172a)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: compact ? '7px 10px' : '10px 12px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--text-secondary, #94a3b8)',
          fontSize: compact ? 12 : 13, fontWeight: 500, textAlign: 'left',
        }}
      >
        <span style={{ flexShrink: 0, color: 'var(--text-muted, #64748b)', display: 'inline-flex' }}>
          {icon ?? <HelpCircle size={compact ? 13 : 14} />}
        </span>
        <span style={{ flex: 1 }}>{title}</span>
        <span style={{ flexShrink: 0, color: 'var(--text-muted, #64748b)', display: 'inline-flex' }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: compact ? '2px 12px 10px 31px' : '4px 14px 14px 34px',
            fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary, #94a3b8)',
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
