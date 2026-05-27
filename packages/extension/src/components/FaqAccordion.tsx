import React, { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'

interface FaqAccordionProps {
  items: Array<{ q: string; a: string }>
  defaultExpandedIndex?: number
}

export const FaqAccordion: React.FC<FaqAccordionProps> = ({ items, defaultExpandedIndex }) => {
  const [expanded, setExpanded] = useState<number | null>(
    typeof defaultExpandedIndex === 'number' ? defaultExpandedIndex : null,
  )

  const toggle = (idx: number) => {
    setExpanded(prev => (prev === idx ? null : idx))
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        border: '1px solid var(--surface-4, rgba(255,255,255,0.06))',
        borderRadius: 'var(--r-md, 8px)',
        background: 'var(--surface-1, #0f172a)',
        overflow: 'hidden',
      }}
    >
      {items.map((item, idx) => {
        const isOpen = expanded === idx
        return (
          <div
            key={idx}
            style={{
              borderBottom:
                idx === items.length - 1
                  ? 'none'
                  : '1px solid var(--surface-4, rgba(255,255,255,0.06))',
            }}
          >
            <button
              type="button"
              onClick={() => toggle(idx)}
              aria-expanded={isOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 12px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-primary, #e2e8f0)',
                fontSize: 13,
                textAlign: 'left',
                cursor: 'pointer',
                fontWeight: 500,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--surface-2, rgba(255,255,255,0.04))'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <span style={{ flexShrink: 0, color: 'var(--text-muted, #64748b)' }}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <span style={{ flex: 1 }}>{item.q}</span>
            </button>
            {isOpen && (
              <div
                style={{
                  padding: '4px 12px 12px 34px',
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: 'var(--text-secondary, #94a3b8)',
                }}
              >
                {item.a}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
