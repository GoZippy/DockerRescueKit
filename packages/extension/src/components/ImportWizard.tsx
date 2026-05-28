import React, { useEffect, useRef, useState } from 'react'
import {
  X,
  Upload,
  FileJson,
  HardDrive,
  Database,
  AlertTriangle,
  Check,
  CircleX,
  Loader2,
  ArrowLeft,
  ChevronRight,
  type LucideProps,
} from 'lucide-react'
import {
  importConfigPreview,
  importConfigApply,
  type ImportPreview,
  type ImportResult,
  type ImportSourceMode,
} from '../api'
import { useToast } from '../hooks/useToast'

/**
 * ImportWizard — Sprint 3 / WA-2 deliverable.
 *
 * Three-step modal that wraps the backend's preview+apply import flow:
 *   1. Source select — JSON upload / bind-mount JSON path / legacy SQLite DB
 *   2. Preview       — show counts + warnings + two-step destructive confirm
 *   3. Result        — success counts or failure errors with retry path
 *
 * The wizard is the *only* user-facing path to ImportService for legacy DB
 * recovery. Power users can still curl the endpoint directly; everyone else
 * goes through here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ImportWizardProps {
  open: boolean
  onClose: () => void
  /** Fires after a successful apply. SettingsPage uses this to refetch meta. */
  onSuccess?: () => void
}

type WizardStep = 'source' | 'preview' | 'result'

type IconComponent = React.FC<LucideProps>

interface SourceOption {
  value: ImportSourceMode
  label: string
  shortLabel: string
  Icon: IconComponent
  hint: string
}

const SOURCE_OPTIONS: SourceOption[] = [
  {
    value: 'json',
    shortLabel: 'Upload JSON',
    label: 'Upload JSON export',
    Icon: FileJson,
    hint: 'Pick a drk-config-*.json file from your computer (e.g. a previous Export config download).',
  },
  {
    value: 'bind-mount-json',
    shortLabel: 'Bind-mount JSON',
    label: 'Bind-mounted JSON path',
    Icon: HardDrive,
    hint: 'Read a JSON file already inside the container. Path must be inside DRK_IMPORT_ALLOWLIST (default /data/imports/).',
  },
  {
    value: 'legacy-sqlite-db',
    shortLabel: 'Legacy SQLite DB',
    label: 'Legacy SQLite DB recovery',
    Icon: Database,
    hint: 'Recover from a salvaged docker_rescue.db. Path must be inside DRK_IMPORT_ALLOWLIST (default /data/imports/).',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export const ImportWizard: React.FC<ImportWizardProps> = ({ open, onClose, onSuccess }) => {
  // ── State machine: step + source + per-source inputs + busy/preview/result
  const [step, setStep]             = useState<WizardStep>('source')
  const [source, setSource]         = useState<ImportSourceMode>('json')
  const [jsonPayload, setJsonPayload] = useState<any | null>(null)
  const [jsonFileName, setJsonFileName] = useState<string | null>(null)
  const [bindMountPath, setBindMountPath] = useState('')
  const [legacyDbPath, setLegacyDbPath]   = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview]       = useState<ImportPreview | null>(null)
  const [applying, setApplying]     = useState(false)
  const [result, setResult]         = useState<ImportResult | null>(null)
  const [error, setError]           = useState<string | null>(null)

  // Two-step destructive confirm (3-second arming window on the apply button)
  const [confirmArmed, setConfirmArmed] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useToast()

  // ── Reset everything when modal opens fresh ─────────────────────────────
  useEffect(() => {
    if (open) {
      resetAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ── Escape closes the wizard ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // ── Clean up dangling confirm timer on unmount/close ────────────────────
  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const resetAll = () => {
    setStep('source')
    setSource('json')
    setJsonPayload(null)
    setJsonFileName(null)
    setBindMountPath('')
    setLegacyDbPath('')
    setPreviewing(false)
    setPreview(null)
    setApplying(false)
    setResult(null)
    setError(null)
    setConfirmArmed(false)
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current)
      confirmTimer.current = null
    }
  }

  // ── Step 1 → 2 transition: call preview ─────────────────────────────────
  const handlePreview = async () => {
    setError(null)
    setPreviewing(true)
    try {
      const req: { source: ImportSourceMode; payload?: any; path?: string } = { source }
      if (source === 'json') {
        if (!jsonPayload) {
          throw new Error('Select a JSON file first.')
        }
        req.payload = jsonPayload
      } else if (source === 'bind-mount-json') {
        if (!bindMountPath.trim()) {
          throw new Error('Enter a path to the JSON file inside the container.')
        }
        req.path = bindMountPath.trim()
      } else {
        if (!legacyDbPath.trim()) {
          throw new Error('Enter a path to the legacy SQLite DB inside the container.')
        }
        req.path = legacyDbPath.trim()
      }
      const p = await importConfigPreview(req)
      setPreview(p)
      setStep('preview')
    } catch (e: any) {
      setError(e?.message ?? 'Preview failed')
    } finally {
      setPreviewing(false)
    }
  }

  // ── Step 2 destructive confirm: click once → arm; click again → fire ────
  const handleApplyClick = async () => {
    if (!preview) return
    if (!confirmArmed) {
      setConfirmArmed(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => {
        setConfirmArmed(false)
        confirmTimer.current = null
      }, 3000)
      return
    }
    // Armed click — fire apply
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current)
      confirmTimer.current = null
    }
    setConfirmArmed(false)
    setApplying(true)
    setError(null)
    try {
      const r = await importConfigApply(preview.confirmationToken)
      setResult(r)
      setStep('result')
      if (r.applied && (!r.errors || r.errors.length === 0)) {
        toast.push('success', 'Config import applied successfully')
        onSuccess?.()
      } else if (r.applied) {
        toast.push('warning', `Import applied with ${r.errors.length} error(s)`)
        onSuccess?.()
      } else {
        toast.push('error', 'Import failed — no changes applied')
      }
    } catch (e: any) {
      const msg = e?.message ?? 'Apply failed'
      setError(msg)
      toast.push('error', `Import failed: ${msg}`)
    } finally {
      setApplying(false)
    }
  }

  // ── Step 2 "Back": discard preview + return to source step ──────────────
  const handleBack = () => {
    setPreview(null)
    setError(null)
    setConfirmArmed(false)
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current)
      confirmTimer.current = null
    }
    setStep('source')
  }

  // ── Step 3 → 1 transition (failure-path "Try again") ────────────────────
  const handleTryAgain = () => {
    setResult(null)
    setPreview(null)
    setError(null)
    setConfirmArmed(false)
    setStep('source')
  }

  if (!open) return null

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
        aria-label="Import configuration"
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
          <Upload size={16} color="var(--amber, #f59e0b)" />
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary, #e2e8f0)', flex: 1 }}>
            Import configuration
          </div>
          <StepIndicator step={step} />
          <button
            className="btn-icon"
            onClick={onClose}
            aria-label="Close import wizard"
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        {step === 'source' && (
          <SourceStep
            source={source}
            onSourceChange={setSource}
            jsonPayload={jsonPayload}
            jsonFileName={jsonFileName}
            onJsonFile={(payload, name) => {
              setJsonPayload(payload)
              setJsonFileName(name)
              setError(null)
            }}
            onJsonError={msg => {
              setJsonPayload(null)
              setJsonFileName(null)
              setError(msg)
            }}
            bindMountPath={bindMountPath}
            onBindMountPathChange={setBindMountPath}
            legacyDbPath={legacyDbPath}
            onLegacyDbPathChange={setLegacyDbPath}
            previewing={previewing}
            error={error}
            onPreview={handlePreview}
            onCancel={onClose}
          />
        )}

        {step === 'preview' && preview && (
          <PreviewStep
            preview={preview}
            applying={applying}
            confirmArmed={confirmArmed}
            error={error}
            onBack={handleBack}
            onApply={handleApplyClick}
          />
        )}

        {step === 'result' && result && (
          <ResultStep
            result={result}
            onClose={onClose}
            onTryAgain={handleTryAgain}
          />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Source selection
// ─────────────────────────────────────────────────────────────────────────────

interface SourceStepProps {
  source: ImportSourceMode
  onSourceChange: (s: ImportSourceMode) => void
  jsonPayload: any | null
  jsonFileName: string | null
  onJsonFile: (payload: any, name: string) => void
  onJsonError: (msg: string) => void
  bindMountPath: string
  onBindMountPathChange: (s: string) => void
  legacyDbPath: string
  onLegacyDbPathChange: (s: string) => void
  previewing: boolean
  error: string | null
  onPreview: () => void
  onCancel: () => void
}

const SourceStep: React.FC<SourceStepProps> = ({
  source, onSourceChange,
  jsonPayload, jsonFileName, onJsonFile, onJsonError,
  bindMountPath, onBindMountPathChange,
  legacyDbPath, onLegacyDbPathChange,
  previewing, error, onPreview, onCancel,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await readFileAsText(file)
      const parsed = JSON.parse(text)
      onJsonFile(parsed, file.name)
    } catch (err: any) {
      onJsonError(`Could not parse JSON: ${err?.message ?? 'invalid file'}`)
    } finally {
      // Allow reselecting the same file
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const canPreview = (() => {
    if (previewing) return false
    if (source === 'json') return !!jsonPayload
    if (source === 'bind-mount-json') return bindMountPath.trim().length > 0
    if (source === 'legacy-sqlite-db') return legacyDbPath.trim().length > 0
    return false
  })()

  const activeOption = SOURCE_OPTIONS.find(o => o.value === source)!

  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-secondary, #94a3b8)', margin: '0 0 12px' }}>
        Restore configuration from a previous export or a salvaged database. This wizard previews
        what will be applied so you can confirm before overwriting current state.
      </p>

      {/* Source picker — segmented radio bar */}
      <Label>Import source</Label>
      <div
        role="radiogroup"
        aria-label="Import source"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}
      >
        {SOURCE_OPTIONS.map(opt => {
          const active = source === opt.value
          const Icon = opt.Icon
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onSourceChange(opt.value)}
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
              <Icon size={13} /> {opt.shortLabel}
            </button>
          )
        })}
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted, #64748b)', margin: '0 0 14px' }}>
        {activeOption.hint}
      </p>

      {/* Per-source input */}
      <div style={{ marginBottom: 14 }}>
        {source === 'json' && (
          <>
            <Label>JSON export file</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={previewing}
              >
                <Upload size={14} /> Select .json file
              </button>
              {jsonFileName && (
                <span
                  className="font-mono"
                  style={{
                    fontSize: 12,
                    color: 'var(--emerald, #10b981)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  title={jsonFileName}
                >
                  <Check size={12} /> {jsonFileName}
                </span>
              )}
            </div>
          </>
        )}

        {source === 'bind-mount-json' && (
          <>
            <Label>Path inside container</Label>
            <input
              type="text"
              value={bindMountPath}
              onChange={e => onBindMountPathChange(e.target.value)}
              placeholder="/data/imports/my-export.json"
              className="font-mono"
              style={textInputStyle}
              disabled={previewing}
              spellCheck={false}
              autoComplete="off"
            />
          </>
        )}

        {source === 'legacy-sqlite-db' && (
          <>
            <Label>Path to recovered docker_rescue.db</Label>
            <input
              type="text"
              value={legacyDbPath}
              onChange={e => onLegacyDbPathChange(e.target.value)}
              placeholder="/data/imports/old-docker_rescue.db"
              className="font-mono"
              style={textInputStyle}
              disabled={previewing}
              spellCheck={false}
              autoComplete="off"
            />
          </>
        )}
      </div>

      {error && <InlineErrorBanner message={error} />}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" type="button" onClick={onCancel} disabled={previewing}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          type="button"
          onClick={onPreview}
          disabled={!canPreview}
          title={
            !canPreview && !previewing
              ? source === 'json'
                ? 'Select a JSON file first'
                : 'Enter a path first'
              : undefined
          }
        >
          {previewing ? (
            <><Loader2 size={14} className="animate-spin" /> Previewing…</>
          ) : (
            <>Preview import <ChevronRight size={14} /></>
          )}
        </button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Preview + destructive confirm
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewStepProps {
  preview: ImportPreview
  applying: boolean
  confirmArmed: boolean
  error: string | null
  onBack: () => void
  onApply: () => void
}

const PreviewStep: React.FC<PreviewStepProps> = ({ preview, applying, confirmArmed, error, onBack, onApply }) => {
  const sourceLabel = SOURCE_OPTIONS.find(o => o.value === preview.source)?.label ?? preview.source

  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-secondary, #94a3b8)', margin: '0 0 12px' }}>
        Review what will be imported. Apply is destructive: existing rows with matching IDs are
        replaced.
      </p>

      {/* Detection summary */}
      <div
        style={{
          background: 'var(--surface-2, rgba(255,255,255,0.04))',
          border: '1px solid var(--surface-4, rgba(255,255,255,0.08))',
          borderRadius: 'var(--r-md, 8px)',
          padding: 12,
          marginBottom: 12,
        }}
      >
        <DetailRow label="Source"       value={sourceLabel} />
        {preview.schemaVersion && (
          <DetailRow label="Schema"     value={preview.schemaVersion} mono />
        )}
        {preview.detectedAppVersion && (
          <DetailRow label="App version" value={preview.detectedAppVersion} mono />
        )}
      </div>

      {/* Counts grid */}
      <Label>What will be imported</Label>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 8,
          marginBottom: 14,
        }}
      >
        <CountTile label="Policies" count={preview.counts.policies} />
        <CountTile label="Vaults"   count={preview.counts.vaults} />
        <CountTile label="Settings" count={preview.counts.settings} />
        <CountTile label="Audit"    count={preview.counts.audit} />
      </div>

      {/* Warnings — amber callout, highlight column mapping issues */}
      {preview.warnings.length > 0 && (
        <div
          style={{
            background: 'rgba(245,158,11,0.1)',
            border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 'var(--r-md, 8px)',
            padding: 12,
            marginBottom: 14,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--amber, #f59e0b)',
              fontWeight: 700,
              fontSize: 13,
              marginBottom: 6,
            }}
          >
            <AlertTriangle size={14} /> Warnings ({preview.warnings.length})
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              color: 'var(--text-secondary, #94a3b8)',
              lineHeight: 1.5,
            }}
          >
            {preview.warnings.map((w, i) => {
              const isColumnMapping = /column|mapping|legacy schema|defaulted/i.test(w)
              return (
                <li
                  key={i}
                  style={{
                    fontWeight: isColumnMapping ? 600 : 400,
                    color: isColumnMapping ? 'var(--amber, #f59e0b)' : undefined,
                  }}
                >
                  {w}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {error && <InlineErrorBanner message={error} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button className="btn btn-ghost" type="button" onClick={onBack} disabled={applying}>
          <ArrowLeft size={14} /> Back
        </button>
        <button
          className="btn btn-danger"
          type="button"
          onClick={onApply}
          disabled={applying}
          aria-live="polite"
        >
          {applying ? (
            <><Loader2 size={14} className="animate-spin" /> Applying…</>
          ) : confirmArmed ? (
            <><AlertTriangle size={14} /> Are you sure? Click again to confirm</>
          ) : (
            <><Upload size={14} /> Apply import — overwrites current config</>
          )}
        </button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Result
// ─────────────────────────────────────────────────────────────────────────────

interface ResultStepProps {
  result: ImportResult
  onClose: () => void
  onTryAgain: () => void
}

const ResultStep: React.FC<ResultStepProps> = ({ result, onClose, onTryAgain }) => {
  const ok = result.applied && (!result.errors || result.errors.length === 0)

  if (ok) {
    return (
      <>
        <div
          style={{
            background: 'rgba(16,185,129,0.1)',
            border: '1px solid rgba(16,185,129,0.3)',
            borderRadius: 'var(--r-md, 8px)',
            padding: 14,
            marginBottom: 14,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--emerald, #10b981)',
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            <Check size={16} /> Imported successfully
          </div>
        </div>

        <Label>Restored counts</Label>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <CountTile label="Policies" count={result.counts.policies} accent="emerald" />
          <CountTile label="Vaults"   count={result.counts.vaults}   accent="emerald" />
          <CountTile label="Settings" count={result.counts.settings} accent="emerald" />
          <CountTile label="Audit"    count={result.counts.audit}    accent="emerald" />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" type="button" onClick={onClose}>Close</button>
        </div>
      </>
    )
  }

  // Failure path (either applied=false or applied=true with errors[])
  const partial = result.applied && result.errors.length > 0
  return (
    <>
      <div
        style={{
          background: 'rgba(244,63,94,0.1)',
          border: '1px solid rgba(244,63,94,0.3)',
          borderRadius: 'var(--r-md, 8px)',
          padding: 14,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--rose, #f43f5e)',
            fontWeight: 700,
            fontSize: 14,
            marginBottom: 4,
          }}
        >
          <CircleX size={16} /> Import {partial ? 'partially' : 'fully'} failed
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)' }}>
          {partial
            ? 'Some rows were applied but the following errors occurred. Your previous config may be in a mixed state — re-export from a known good source if available.'
            : 'No changes were applied. See errors below.'}
        </div>
      </div>

      {result.errors.length > 0 && (
        <>
          <Label>Errors ({result.errors.length})</Label>
          <pre
            className="font-mono"
            style={{
              background: 'var(--surface-0, #020617)',
              border: '1px solid var(--surface-4, rgba(255,255,255,0.08))',
              borderRadius: 'var(--r-sm, 6px)',
              padding: 10,
              fontSize: 11,
              color: 'var(--rose, #f43f5e)',
              maxHeight: 200,
              overflow: 'auto',
              margin: '0 0 14px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {result.errors.join('\n')}
          </pre>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button className="btn btn-ghost" type="button" onClick={onClose}>Close</button>
        <button className="btn btn-primary" type="button" onClick={onTryAgain}>Try again</button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Small inline helpers
// ─────────────────────────────────────────────────────────────────────────────

const StepIndicator: React.FC<{ step: WizardStep }> = ({ step }) => {
  const idx = step === 'source' ? 1 : step === 'preview' ? 2 : 3
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        color: 'var(--text-muted, #64748b)',
        padding: '2px 8px',
        border: '1px solid var(--surface-4, rgba(255,255,255,0.08))',
        borderRadius: 'var(--r-sm, 6px)',
        marginRight: 4,
      }}
      aria-label={`Step ${idx} of 3`}
    >
      Step {idx}/3
    </span>
  )
}

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: 'var(--text-muted, #64748b)',
      fontWeight: 600,
      marginBottom: 6,
    }}
  >
    {children}
  </div>
)

const InlineErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <div
    role="alert"
    style={{
      background: 'rgba(244,63,94,0.1)',
      border: '1px solid rgba(244,63,94,0.3)',
      borderRadius: 'var(--r-sm, 6px)',
      padding: 10,
      marginBottom: 12,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      color: 'var(--rose, #f43f5e)',
      fontSize: 12,
    }}
  >
    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
    <span style={{ wordBreak: 'break-word' }}>{message}</span>
  </div>
)

const DetailRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, padding: '3px 0' }}>
    <span style={{ color: 'var(--text-muted, #64748b)', minWidth: 90 }}>{label}</span>
    <span
      className={mono ? 'font-mono' : undefined}
      style={{ color: 'var(--text-primary, #e2e8f0)' }}
    >
      {value}
    </span>
  </div>
)

const CountTile: React.FC<{ label: string; count: number; accent?: 'emerald' }> = ({ label, count, accent }) => {
  const color = accent === 'emerald' ? 'var(--emerald, #10b981)' : 'var(--text-primary, #e2e8f0)'
  return (
    <div
      style={{
        background: 'var(--surface-2, rgba(255,255,255,0.04))',
        border: '1px solid var(--surface-4, rgba(255,255,255,0.08))',
        borderRadius: 'var(--r-sm, 6px)',
        padding: '8px 10px',
        textAlign: 'center',
      }}
    >
      <div
        className="font-mono"
        style={{ fontSize: 18, fontWeight: 700, color, lineHeight: 1.1 }}
      >
        {count}
      </div>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--text-muted, #64748b)',
          marginTop: 2,
        }}
      >
        {label}
      </div>
    </div>
  )
}

const textInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  color: 'var(--text-primary, #e2e8f0)',
  background: 'var(--surface-0, #020617)',
  border: '1px solid var(--surface-4, rgba(255,255,255,0.08))',
  borderRadius: 'var(--r-sm, 6px)',
  boxSizing: 'border-box',
}

// FileReader helper — small promise wrapper around the browser API
const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'))
    reader.readAsText(file)
  })
