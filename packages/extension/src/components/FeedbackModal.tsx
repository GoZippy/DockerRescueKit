import React, { useEffect, useRef, useState } from 'react'
import {
  X,
  Bug,
  Lightbulb,
  Sparkles,
  Plug,
  HelpCircle,
  Camera,
  Loader2,
  Check,
  AlertTriangle,
  Trash2,
  type LucideProps,
} from 'lucide-react'
import { submitFeedback } from '../api'
import { FaqAccordion } from './FaqAccordion'

type FeedbackType = 'bug' | 'suggestion' | 'wish' | 'integration_request' | 'question'

interface FeedbackModalProps {
  open: boolean
  onClose: () => void
  context?: { page?: string; version?: string; dataDir?: string }
}

const MAX_MESSAGE_CHARS = 16000

type IconComponent = React.FC<LucideProps>

const TYPE_OPTIONS: Array<{ value: FeedbackType; label: string; Icon: IconComponent }> = [
  { value: 'bug',                 label: 'Bug report',                            Icon: Bug },
  { value: 'suggestion',          label: 'Suggestion',                            Icon: Lightbulb },
  { value: 'wish',                label: "Wish — 'I wish this page did X'",      Icon: Sparkles },
  { value: 'integration_request', label: 'Integration / tool request',            Icon: Plug },
  { value: 'question',            label: 'Question',                              Icon: HelpCircle },
]

const FAQ_ITEMS: Array<{ q: string; a: string }> = [
  {
    q: 'Where does Docker Rescue Kit store backups by default?',
    a: 'Inside the data directory you mounted into the container (default: /var/lib/drk on the host, mapped to /data inside the container). Snapshots, manifests, and the encryption key all live under that root unless you configured a remote vault (S3/B2/rclone).',
  },
  {
    q: 'How do I restore a single file from a backup instead of the whole volume?',
    a: 'Open the snapshot in Backup History, click "Browse contents" to mount it read-only, then use the partial-restore browser to tick the files or subfolders you want. Selected paths can be extracted to a staging directory or piped back into the original volume.',
  },
  {
    q: "What's the difference between verify and rehearsal?",
    a: 'Verify confirms each snapshot can be read end-to-end and that its checksums match the manifest — it never touches a real volume. Rehearsal goes further: it restores the snapshot into a throwaway test volume and starts the original service against it, so you know the data actually boots.',
  },
  {
    q: 'Can I back up to S3 / Backblaze B2 / a Synology NAS?',
    a: 'Yes. S3 and B2 are supported natively via restic. For SMB/SFTP/WebDAV targets (Synology, TrueNAS, etc.) use the rclone wizard to register a remote, then point a vault at it. The shipped Docker image bundles both restic and rclone binaries.',
  },
  {
    q: 'How do I upgrade to the Pro tier?',
    a: 'Buy a license from gozippy.com/drk, then paste the activation key into Settings → License. Pro unlocks remote vaults, scheduled rehearsals, and the cost-analysis page. The activation is offline-friendly — once issued, the key validates against an embedded public key without phoning home.',
  },
  {
    q: 'The extension shows v1.1.0 even after I updated — what\'s going on?',
    a: 'The version label in the UI comes from the backend\'s package.json baked into the container image, so it can lag the image tag if the build step wasn\'t bumped. To confirm what\'s actually running, check Settings → Updates — that panel queries Docker Hub and shows the latest published tag alongside what you\'re running.',
  },
]

const TYPE_LABEL: Record<FeedbackType, string> = {
  bug: 'Bug report',
  suggestion: 'Suggestion',
  wish: 'Wish',
  integration_request: 'Integration request',
  question: 'Question',
}

type SubmitResult = { id: string; sinks: Record<string, 'sent' | 'failed' | 'skipped'> }

export const FeedbackModal: React.FC<FeedbackModalProps> = ({ open, onClose, context }) => {
  const [type, setType] = useState<FeedbackType>('bug')
  const [message, setMessage] = useState('')
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  const [screenshotPng, setScreenshotPng] = useState<string | null>(null)
  const [screenshotBytes, setScreenshotBytes] = useState<number>(0)
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<SubmitResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setType('bug')
      setMessage('')
      setIncludeScreenshot(false)
      setScreenshotPng(null)
      setScreenshotBytes(0)
      setCapturing(false)
      setCaptureError(null)
      setSubmitting(false)
      setResult(null)
      setError(null)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Autofocus message textarea when modal opens (and not in result state)
  useEffect(() => {
    if (open && !result) {
      const t = setTimeout(() => messageRef.current?.focus(), 40)
      return () => clearTimeout(t)
    }
  }, [open, result])

  const captureScreenshot = async () => {
    setCapturing(true)
    setCaptureError(null)
    try {
      const md: any = (navigator as any).mediaDevices
      if (!md || typeof md.getDisplayMedia !== 'function') {
        throw new Error('Screen capture not supported in this browser')
      }
      const stream: MediaStream = await md.getDisplayMedia({ video: true, audio: false })
      try {
        const track = stream.getVideoTracks()[0]
        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        await video.play()
        // Wait one frame so the video element has dimensions
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const w = video.videoWidth || 1280
        const h = video.videoHeight || 720
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Could not get canvas context')
        ctx.drawImage(video, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/png')
        // Strip "data:image/png;base64," prefix
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
        // Estimate decoded byte size (base64 is ~4/3 of binary)
        const bytes = Math.floor((base64.length * 3) / 4)
        setScreenshotPng(base64)
        setScreenshotBytes(bytes)
        track?.stop()
      } finally {
        stream.getTracks().forEach(t => t.stop())
      }
    } catch (e: any) {
      // User-denied permission, dismissed picker, or unsupported
      const msg =
        e?.name === 'NotAllowedError' || /denied|cancel/i.test(String(e?.message ?? ''))
          ? 'Screen capture cancelled'
          : e?.message || 'Screen capture failed'
      setCaptureError(msg)
      setIncludeScreenshot(false)
    } finally {
      setCapturing(false)
    }
  }

  const removeScreenshot = () => {
    setScreenshotPng(null)
    setScreenshotBytes(0)
    setCaptureError(null)
  }

  const onToggleScreenshot = async (checked: boolean) => {
    setIncludeScreenshot(checked)
    setCaptureError(null)
    if (checked && !screenshotPng) {
      await captureScreenshot()
    }
    if (!checked) {
      removeScreenshot()
    }
  }

  const submit = async () => {
    if (!message.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await submitFeedback({
        type,
        message: message.trim(),
        screenshotPngBase64: includeScreenshot && screenshotPng ? screenshotPng : undefined,
        context: {
          ...(context || {}),
          userAgent: navigator.userAgent,
        },
      })
      setResult(res)
    } catch (e: any) {
      setError(e?.message || 'Failed to submit feedback')
    } finally {
      setSubmitting(false)
    }
  }

  const resetForm = () => {
    setError(null)
    setResult(null)
  }

  if (!open) return null

  const charCount = message.length
  const overLimit = charCount > MAX_MESSAGE_CHARS
  const canSubmit = !!message.trim() && !overLimit && !submitting

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send feedback"
        onClick={e => e.stopPropagation()}
        className="card"
        style={{
          width: '100%',
          maxWidth: 640,
          maxHeight: '90vh',
          overflow: 'auto',
          background: 'var(--surface-1, #0f172a)',
          border: '1px solid var(--surface-4, rgba(255,255,255,0.08))',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          padding: 20,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary, #e2e8f0)', flex: 1 }}>
            Send feedback
          </div>
          <button
            className="btn-icon"
            onClick={onClose}
            aria-label="Close feedback dialog"
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        {result ? (
          <SuccessPanel result={result} onClose={onClose} />
        ) : error ? (
          <ErrorPanel error={error} onRetry={resetForm} onClose={onClose} />
        ) : (
          <>
            {/* Type selector */}
            <div style={{ marginBottom: 14 }}>
              <Label>What kind of feedback?</Label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {TYPE_OPTIONS.map(opt => {
                  const active = type === opt.value
                  const Icon = opt.Icon
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setType(opt.value)}
                      aria-pressed={active}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 10px',
                        fontSize: 12,
                        fontWeight: 500,
                        borderRadius: 'var(--r-sm, 6px)',
                        cursor: 'pointer',
                        border: active
                          ? '1px solid var(--blue-500, #3b82f6)'
                          : '1px solid var(--surface-4, rgba(255,255,255,0.08))',
                        background: active
                          ? 'rgba(59,130,246,0.15)'
                          : 'var(--surface-2, rgba(255,255,255,0.04))',
                        color: active
                          ? 'var(--text-primary, #e2e8f0)'
                          : 'var(--text-secondary, #94a3b8)',
                        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                      }}
                    >
                      <Icon size={13} />
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* FAQ */}
            <div style={{ marginBottom: 14 }}>
              <Label>Common questions — check before reporting</Label>
              <FaqAccordion items={FAQ_ITEMS} />
            </div>

            {/* Message */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                <Label noMargin>Your message</Label>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 11,
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    color: overLimit ? 'var(--rose, #f43f5e)' : 'var(--text-muted, #64748b)',
                  }}
                >
                  {charCount} / {MAX_MESSAGE_CHARS}
                </span>
              </div>
              <textarea
                ref={messageRef}
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder={
                  type === 'bug'
                    ? 'What did you expect to happen? What actually happened? Steps to reproduce…'
                    : type === 'question'
                    ? 'Ask away…'
                    : 'Tell us what you have in mind…'
                }
                style={{
                  width: '100%',
                  minHeight: 120,
                  resize: 'vertical',
                  padding: '10px 12px',
                  fontSize: 13,
                  lineHeight: 1.5,
                  fontFamily: 'inherit',
                  color: 'var(--text-primary, #e2e8f0)',
                  background: 'var(--surface-0, #020617)',
                  border: `1px solid ${overLimit ? 'var(--rose, #f43f5e)' : 'var(--surface-4, rgba(255,255,255,0.08))'}`,
                  borderRadius: 'var(--r-sm, 6px)',
                  boxSizing: 'border-box',
                }}
                maxLength={MAX_MESSAGE_CHARS + 1000 /* allow visual overflow so counter can warn */}
              />
            </div>

            {/* Screenshot */}
            <div style={{ marginBottom: 16 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--text-secondary, #94a3b8)',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={includeScreenshot}
                  onChange={e => onToggleScreenshot(e.target.checked)}
                  disabled={capturing}
                />
                <Camera size={13} />
                Attach screenshot of current view (PNG)
              </label>

              {capturing && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted, #64748b)', marginTop: 8, paddingLeft: 22 }}>
                  <Loader2 size={12} className="animate-spin" /> Waiting for screen share permission…
                </div>
              )}

              {captureError && !capturing && (
                <div
                  title={captureError}
                  style={{
                    marginTop: 8,
                    paddingLeft: 22,
                    fontSize: 11,
                    color: 'var(--amber, #f59e0b)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <AlertTriangle size={11} /> {captureError}
                </div>
              )}

              {screenshotPng && !capturing && (
                <div
                  style={{
                    marginTop: 10,
                    marginLeft: 22,
                    padding: '8px 10px',
                    borderRadius: 'var(--r-sm, 6px)',
                    background: 'var(--surface-2, rgba(255,255,255,0.04))',
                    border: '1px solid var(--surface-4, rgba(255,255,255,0.06))',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <img
                    src={`data:image/png;base64,${screenshotPng}`}
                    alt="Screenshot preview"
                    style={{
                      width: 64,
                      height: 40,
                      objectFit: 'cover',
                      borderRadius: 4,
                      border: '1px solid var(--surface-4, rgba(255,255,255,0.08))',
                    }}
                  />
                  <div style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary, #94a3b8)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--emerald, #10b981)' }}>
                      <Check size={12} /> Screenshot captured
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted, #64748b)' }}>
                      {(screenshotBytes / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={removeScreenshot}
                    aria-label="Remove screenshot"
                    title="Remove screenshot"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" type="button" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                title={!message.trim() ? 'Enter a message first' : overLimit ? 'Message too long' : undefined}
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Sending…
                  </>
                ) : (
                  <>Send {TYPE_LABEL[type].toLowerCase()}</>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const Label: React.FC<{ children: React.ReactNode; noMargin?: boolean }> = ({ children, noMargin }) => (
  <div
    style={{
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: 'var(--text-muted, #64748b)',
      fontWeight: 600,
      marginBottom: noMargin ? 0 : 6,
    }}
  >
    {children}
  </div>
)

const SINK_COLOR: Record<'sent' | 'failed' | 'skipped', string> = {
  sent: 'var(--emerald, #10b981)',
  failed: 'var(--rose, #f43f5e)',
  skipped: 'var(--text-muted, #64748b)',
}

const SuccessPanel: React.FC<{ result: SubmitResult; onClose: () => void }> = ({ result, onClose }) => {
  const sinks = Object.entries(result.sinks)
  return (
    <div>
      <div
        style={{
          background: 'rgba(16,185,129,0.1)',
          border: '1px solid rgba(16,185,129,0.3)',
          borderRadius: 'var(--r-md, 8px)',
          padding: 14,
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--emerald, #10b981)', fontWeight: 700, marginBottom: 6 }}>
          <Check size={16} /> Feedback submitted — thank you!
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)' }}>
          Reference ID:{' '}
          <span className="font-mono" style={{ color: 'var(--text-primary, #e2e8f0)' }}>
            {result.id}
          </span>
        </div>
      </div>

      {sinks.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted, #64748b)', fontWeight: 600, marginBottom: 6 }}>
            Delivery
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sinks.map(([name, status]) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  background: 'var(--surface-2, rgba(255,255,255,0.04))',
                  borderRadius: 'var(--r-sm, 6px)',
                  fontSize: 12,
                }}
              >
                <span className="font-mono" style={{ flex: 1, color: 'var(--text-primary, #e2e8f0)' }}>
                  {name}
                </span>
                <span
                  className="badge"
                  style={{
                    color: SINK_COLOR[status],
                    background: 'transparent',
                    border: `1px solid ${SINK_COLOR[status]}`,
                    textTransform: 'uppercase',
                    fontSize: 10,
                    letterSpacing: '0.04em',
                  }}
                >
                  {status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

const ErrorPanel: React.FC<{ error: string; onRetry: () => void; onClose: () => void }> = ({ error, onRetry, onClose }) => (
  <div>
    <div
      style={{
        background: 'rgba(244,63,94,0.1)',
        border: '1px solid rgba(244,63,94,0.3)',
        borderRadius: 'var(--r-md, 8px)',
        padding: 14,
        marginBottom: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--rose, #f43f5e)', fontWeight: 700, marginBottom: 6 }}>
        <AlertTriangle size={16} /> Could not send feedback
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)' }}>{error}</div>
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button className="btn btn-ghost" type="button" onClick={onClose}>
        Cancel
      </button>
      <button className="btn btn-primary" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  </div>
)
