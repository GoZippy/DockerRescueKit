import React from 'react'
import { ExternalLink } from 'lucide-react'
import { HelpDisclosure } from './HelpDisclosure'
import { FaqAccordion } from './FaqAccordion'
import { helpFor, IntegrationHelp } from '../integrationsHelp'

interface Props {
  /** rclone provider id (drive, b2 …) or DRK ConnectorType (proxmox, smb …). */
  integrationKey?: string
  /** Or pass a help block directly (e.g. the rclone overview). */
  help?: IntegrationHelp
  /** Disclosure title; defaults to "What is this & what do I need?". */
  title?: string
  defaultOpen?: boolean
  compact?: boolean
}

const Line: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ marginBottom: 8 }}>
    <span style={{ fontWeight: 600, color: 'var(--text-primary, #e2e8f0)' }}>{label} </span>
    <span>{children}</span>
  </div>
)

/**
 * Renders a single integration's help as a collapsed-by-default disclosure:
 * what it is, when to use it, what you need, an optional engineer note, a docs
 * link, and any integration-specific FAQs. Driven entirely by the data in
 * integrationsHelp.ts so every backend gets consistent, self-documenting help.
 */
export const ConnectorHelp: React.FC<Props> = ({
  integrationKey, help, title, defaultOpen = false, compact = false,
}) => {
  const h = help ?? helpFor(integrationKey)
  if (!h) return null

  return (
    <HelpDisclosure
      title={title ?? 'What is this & what do I need?'}
      defaultOpen={defaultOpen}
      compact={compact}
    >
      <Line label="What it is:">{h.whatItIs}</Line>
      <Line label="When to use it:">{h.whenToUse}</Line>
      <Line label="What you'll need:">{h.whatYouNeed}</Line>
      {h.forEngineers && (
        <Line label="For engineers:">
          <span style={{ color: 'var(--text-muted, #64748b)' }}>{h.forEngineers}</span>
        </Line>
      )}
      {h.docsUrl && (
        <a
          href={h.docsUrl}
          target="_blank"
          rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--blue-400, #60a5fa)', fontSize: 12 }}
        >
          <ExternalLink size={12} /> {h.docsLabel ?? 'Documentation'}
        </a>
      )}
      {h.faqs && h.faqs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <FaqAccordion items={h.faqs} />
        </div>
      )}
    </HelpDisclosure>
  )
}
