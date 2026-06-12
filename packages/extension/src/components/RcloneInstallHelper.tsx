import React, { useState } from 'react'
import { Copy, Check, Terminal, ShieldCheck, ExternalLink } from 'lucide-react'
import { HelpDisclosure } from './HelpDisclosure'

type OS = 'windows' | 'macos' | 'linux'

interface Method {
  label: string
  note?: string
  command: string
}

const METHODS: Record<OS, Method[]> = {
  windows: [
    { label: 'winget (built into Windows 10/11)', command: 'winget install -e --id Rclone.Rclone' },
    { label: 'Scoop', command: 'scoop install rclone' },
    { label: 'Chocolatey', command: 'choco install rclone -y' },
  ],
  macos: [
    { label: 'Homebrew', command: 'brew install rclone' },
    { label: 'MacPorts', command: 'sudo port install rclone' },
    { label: 'Official script', note: 'Installs the latest signed release.', command: 'curl https://rclone.org/install.sh | sudo bash' },
  ],
  linux: [
    { label: 'Official script (any distro)', note: 'Verifies the download for you.', command: 'sudo -v ; curl https://rclone.org/install.sh | sudo bash' },
    { label: 'Debian / Ubuntu', command: 'sudo apt update && sudo apt install -y rclone' },
    { label: 'Fedora / RHEL', command: 'sudo dnf install -y rclone' },
    { label: 'Arch', command: 'sudo pacman -S rclone' },
  ],
}

const OS_LABEL: Record<OS, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

function detectOS(): OS {
  const ua = (navigator.userAgent || '').toLowerCase()
  // userAgentData is the modern, UA-string-independent signal where available.
  const plat = ((navigator as any).userAgentData?.platform || navigator.platform || '').toLowerCase()
  if (plat.includes('win') || ua.includes('windows')) return 'windows'
  if (plat.includes('mac') || ua.includes('mac os')) return 'macos'
  return 'linux'
}

const CopyRow: React.FC<{ command: string }> = ({ command }) => {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="font-mono" style={{
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
      background: 'var(--surface-1)', padding: '7px 10px', borderRadius: 'var(--r-sm)',
    }}>
      <Terminal size={13} color="var(--text-muted)" style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, wordBreak: 'break-all' }}>{command}</span>
      <button className="btn-icon" onClick={copy} title="Copy command" aria-label="Copy command" style={{ flexShrink: 0 }}>
        {copied ? <Check size={13} color="var(--emerald)" /> : <Copy size={13} />}
      </button>
    </div>
  )
}

interface Props {
  /**
   * Where this rclone needs to live:
   *  - 'host'      → the user's own desktop, for the OAuth browser sign-in
   *  - 'backend'   → the DRK host itself (rare; normally bundled)
   */
  context?: 'host' | 'backend'
}

/**
 * Helps the user get rclone installed on the right machine, picking the method
 * that fits their OS. Defaults to the detected platform but lets them switch,
 * and offers a "verify first" path for admins who won't pipe curl into a shell.
 */
export const RcloneInstallHelper: React.FC<Props> = ({ context = 'host' }) => {
  const [os, setOs] = useState<OS>(detectOS())

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {context === 'host' && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
          Install this on <strong>the computer with your web browser</strong> — the one you'll sign in
          on. It's a single file and takes a few seconds. DRK already has its own copy for transfers.
        </p>
      )}

      {/* OS picker */}
      <div style={{ display: 'flex', gap: 6 }}>
        {(Object.keys(OS_LABEL) as OS[]).map(o => (
          <button
            key={o}
            className={`btn ${os === o ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 12, padding: '5px 12px' }}
            onClick={() => setOs(o)}
            aria-pressed={os === o}
          >
            {OS_LABEL[o]}
          </button>
        ))}
      </div>

      {/* Methods for the chosen OS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {METHODS[os].map(m => (
          <div key={m.label}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              {m.label}
              {m.note && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> — {m.note}</span>}
            </div>
            <CopyRow command={m.command} />
          </div>
        ))}
      </div>

      {/* Verify-first path for cautious admins */}
      <HelpDisclosure
        compact
        icon={<ShieldCheck size={13} />}
        title="Verify the download before trusting it (for cautious admins)"
      >
        <p style={{ marginTop: 0 }}>
          Package managers above already verify signatures. To verify a manual download yourself:
          grab the zip for your platform from{' '}
          <a href="https://rclone.org/downloads/" target="_blank" rel="noreferrer" style={{ color: 'var(--blue-400, #60a5fa)' }}>
            rclone.org/downloads
          </a>, then check its checksum against the published <span className="font-mono">SHA256SUMS</span>:
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {os === 'windows'
            ? <CopyRow command={'Get-FileHash .\\rclone-*.zip -Algorithm SHA256  # compare to SHA256SUMS'} />
            : <CopyRow command={'sha256sum -c SHA256SUMS 2>/dev/null | grep rclone   # OK = match'} />}
        </div>
        <p style={{ marginBottom: 0 }}>
          rclone releases are also GPG-signed — see{' '}
          <a href="https://rclone.org/install/#install-with-package-manager" target="_blank" rel="noreferrer" style={{ color: 'var(--blue-400, #60a5fa)' }}>
            the install/verify guide
          </a>.
        </p>
      </HelpDisclosure>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
        <ExternalLink size={12} />
        <span>
          Prefer a script? Run{' '}
          <span className="font-mono">{os === 'windows' ? 'tools/check-rclone.ps1' : 'tools/check-rclone.sh'}</span>{' '}
          from the DRK repo to detect rclone and print the right install command (add{' '}
          <span className="font-mono">{os === 'windows' ? '-Install' : '--install'}</span> to do it for you).
        </span>
      </div>
    </div>
  )
}
