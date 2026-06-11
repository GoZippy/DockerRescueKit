import React, { useState } from 'react'
import { Shield, Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react'
import { setApiKey, getApiBase } from '../api'

const TcpSetupScreen: React.FC = () => {
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleConnect = async () => {
    const trimmed = key.trim()
    setError(null)

    if (!trimmed) {
      setError('Please enter your API key.')
      return
    }
    if (trimmed.length < 16) {
      setError('That key looks too short — API keys are at least 16 characters.')
      return
    }

    setBusy(true)
    try {
      // Test the key against /api/status BEFORE saving it so a wrong key
      // doesn't punt the user into a broken Dashboard.
      const res = await fetch(`${getApiBase()}/status`, {
        headers: { 'x-api-key': trimmed },
      })
      if (res.status === 401) {
        setError('Invalid API key. Double-check the value from your backend logs.')
        setBusy(false)
        return
      }
      if (!res.ok) {
        setError(`Backend returned ${res.status}. Is the Docker Rescue Kit container running?`)
        setBusy(false)
        return
      }
      // Success — persist and reload. Spinner stays visible until reload completes.
      setApiKey(trimmed)
    } catch (e: any) {
      setError(`Could not reach the backend: ${e?.message || 'network error'}`)
      setBusy(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !busy) handleConnect()
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--surface-0)',
      padding: 24,
    }}>
      <div style={{
        width: '100%',
        maxWidth: 460,
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: 'var(--blue-500)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Shield size={28} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
              Connect to Docker Rescue Kit
            </h1>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
              You need an API key to connect this browser app to your
              Docker Rescue Kit backend. The key is generated automatically
              when the backend first starts.
            </p>
          </div>
        </div>

        {/* How to find the key — shown BEFORE the input so users know what to paste */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Where is my API key?
          </span>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
            Run this on the host where the Docker Rescue Kit container is running:
          </p>
          <div style={{
            background: 'var(--surface-0)',
            border: '1px solid var(--surface-4)',
            borderRadius: 'var(--r-md)',
            padding: '10px 14px',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 13,
            color: 'var(--emerald)',
          }}>
            docker logs drk | grep 'API key'
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
            Copy the key from that output and paste it below.
            You can also find it in the{' '}
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>apiKey</span>
            {' '}field inside{' '}
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>data/secrets.json</span>
            {' '}in your data directory.
          </p>
        </div>

        {/* Input card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              API Key
            </label>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={key}
                onChange={e => { setKey(e.target.value); if (error) setError(null) }}
                onKeyDown={handleKeyDown}
                placeholder="drk_••••••••••••••••"
                autoFocus
                spellCheck={false}
                disabled={busy}
                style={{
                  width: '100%',
                  background: 'var(--surface-3)',
                  border: `1px solid ${error ? 'var(--rose)' : 'var(--surface-4)'}`,
                  borderRadius: 'var(--r-md)',
                  padding: '10px 42px 10px 12px',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  fontFamily: 'ui-monospace, monospace',
                  outline: 'none',
                  transition: 'border-color 0.15s',
                }}
                onFocus={e => { if (!error) e.currentTarget.style.borderColor = 'var(--blue-500)' }}
                onBlur={e => { if (!error) e.currentTarget.style.borderColor = 'var(--surface-4)' }}
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                className="btn-icon"
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
                title={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            {error && (
              <div
                role="alert"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  fontSize: 12,
                  color: 'var(--rose)',
                  marginTop: 2,
                  lineHeight: 1.5,
                }}
              >
                <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{error}</span>
              </div>
            )}
          </div>

          <button
            className="btn btn-primary"
            onClick={handleConnect}
            disabled={!key.trim() || busy}
            style={{ justifyContent: 'center', gap: 8 }}
          >
            {busy ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Connecting…
              </>
            ) : (
              'Connect'
            )}
          </button>
        </div>

        {/* Docker Desktop note */}
        <div style={{
          background: 'var(--blue-dim)',
          border: '1px solid var(--blue-border)',
          borderRadius: 'var(--r-md)',
          padding: '12px 14px',
          fontSize: 13,
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
        }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Using Docker Desktop Extension?</span>{' '}
          The API key is auto-injected by the extension host — you should not need to enter it here.
          If you see this screen inside Docker Desktop, please file a bug.
        </div>
      </div>
    </div>
  )
}

// In Docker Desktop extension mode the API-key onboarding flow is irrelevant
// — Desktop's IPC channel authenticates the request for us. We render a tiny
// ready splash so the build flag DCEs the entire TCP onboarding card away.
const ExtensionReadySplash: React.FC = () => (
  <div style={{
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--surface-0)',
    padding: 24,
  }}>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{
        width: 56,
        height: 56,
        borderRadius: 14,
        background: 'var(--blue-500)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Shield size={28} color="#fff" />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Docker Rescue Kit</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Ready.</div>
    </div>
  </div>
)

export const SetupScreen: React.FC =
  import.meta.env.VITE_TRANSPORT === 'extension' ? ExtensionReadySplash : TcpSetupScreen

