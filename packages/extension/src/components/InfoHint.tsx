import React from 'react'
import { Info } from 'lucide-react'

interface InfoHintProps {
  /** Tooltip text shown on hover/focus. */
  text: string
  size?: number
}

/**
 * A tiny inline info icon that surfaces a one-line explanation on hover/focus.
 * Zero-dependency (native title + aria-label) so it stays accessible to
 * keyboard and screen-reader users without pulling in a popover library.
 */
export const InfoHint: React.FC<InfoHintProps> = ({ text, size = 13 }) => (
  <span
    role="img"
    tabIndex={0}
    title={text}
    aria-label={text}
    style={{
      display: 'inline-flex', alignItems: 'center', marginLeft: 5,
      color: 'var(--text-muted, #64748b)', cursor: 'help', verticalAlign: 'middle',
    }}
  >
    <Info size={size} />
  </span>
)
