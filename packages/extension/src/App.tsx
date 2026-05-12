import React, { useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { VaultList } from './components/VaultList'
import { SecurityAudit } from './components/SecurityAudit'
import { PolicyList } from './components/PolicyList'
import { ConnectorsPage } from './components/ConnectorsPage'
import { BackupHistory } from './components/BackupHistory'
import { VerifyHistory } from './components/VerifyHistory'
import { SettingsPage } from './components/SettingsPage'
import { StacksPage } from './components/StacksPage'
import { SetupScreen } from './components/SetupScreen'
import { getApiKey } from './api'
import { ToastProvider } from './hooks/useToast'
import {
  Activity, Database, Layers, Clock, ShieldCheck,
  Server, Plug, Shield, Settings, Menu, X, ChevronLeft,
  type LucideProps,
} from 'lucide-react'

type TabId =
  | 'dashboard' | 'policies' | 'stacks' | 'history' | 'verify'
  | 'storage' | 'connectors' | 'audit' | 'settings'

interface NavItem {
  id: TabId
  label: string
  icon: React.FC<LucideProps>
  bottomNav?: boolean
}

const NAV: NavItem[] = [
  { id: 'dashboard',  label: 'Dashboard',       icon: Activity,    bottomNav: true },
  { id: 'policies',   label: 'Backup Policies',  icon: Database,    bottomNav: true },
  { id: 'stacks',     label: 'Compose Stacks',   icon: Layers,      bottomNav: true },
  { id: 'history',    label: 'Backup History',   icon: Clock,       bottomNav: true },
  { id: 'verify',     label: 'Verify History',   icon: ShieldCheck, bottomNav: false },
  { id: 'storage',    label: 'Storage Vault',    icon: Server,      bottomNav: false },
  { id: 'connectors', label: 'Connectors',       icon: Plug,        bottomNav: false },
  { id: 'audit',      label: 'Security Audit',   icon: Shield,      bottomNav: false },
  { id: 'settings',   label: 'Settings',         icon: Settings,    bottomNav: false },
]

const BOTTOM_NAV = NAV.filter(n => n.bottomNav)

// "More" drawer for non-bottom-nav items on mobile
const MORE_NAV = NAV.filter(n => !n.bottomNav)

const MainApp: React.FC = () => {
  const [active, setActive] = useState<TabId>('dashboard')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Show setup screen when no API key is configured. Skipped entirely in
  // Docker Desktop extension mode — Desktop's IPC channel handles auth.
  if (import.meta.env.VITE_TRANSPORT !== 'extension' && !getApiKey()) {
    return <SetupScreen />
  }

  const currentPage = NAV.find(n => n.id === active)

  const navigate = (id: TabId) => {
    setActive(id)
    setMobileMenuOpen(false)
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--surface-0)' }}>

      {/* ── Sidebar (≥768px) ─────────────────────────────────── */}
      <aside
        className={`sidebar ${sidebarCollapsed ? 'icon-only' : ''}`}
        style={{ display: 'none' }}
        id="sidebar-desktop"
      >
        {/* Logo */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 14px 12px',
          borderBottom: '1px solid var(--surface-4)',
          flexShrink: 0,
          overflow: 'hidden',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'var(--blue-500)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Shield size={18} color="#fff" />
          </div>
          {!sidebarCollapsed && (
            <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
              RescueKit
            </span>
          )}
        </div>

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '8px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
          {NAV.map(item => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={`sidebar-item ${active === item.id ? 'active' : ''}`}
              title={sidebarCollapsed ? item.label : undefined}
              style={{ marginBottom: 2 }}
            >
              <item.icon size={18} />
              {!sidebarCollapsed && <span>{item.label}</span>}
            </button>
          ))}
        </nav>

        {/* Collapse toggle */}
        <button
          onClick={() => setSidebarCollapsed(c => !c)}
          className="btn-icon"
          style={{
            margin: '8px',
            width: sidebarCollapsed ? 48 : 'calc(100% - 16px)',
            justifyContent: sidebarCollapsed ? 'center' : 'flex-end',
          }}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronLeft
            size={16}
            style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }}
          />
        </button>
      </aside>

      {/* ── Mobile overlay menu ──────────────────────────────── */}
      {mobileMenuOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            zIndex: 40,
          }}
          id="mobile-overlay"
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            style={{
              position: 'absolute', top: 0, left: 0, bottom: 0,
              width: 260, background: 'var(--surface-1)',
              borderRight: '1px solid var(--surface-4)',
              padding: '16px 8px',
              overflowY: 'auto',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px 12px', borderBottom: '1px solid var(--surface-4)', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>RescueKit</span>
              <button className="btn-icon" onClick={() => setMobileMenuOpen(false)}>
                <X size={18} />
              </button>
            </div>
            {NAV.map(item => (
              <button
                key={item.id}
                onClick={() => navigate(item.id)}
                className={`sidebar-item ${active === item.id ? 'active' : ''}`}
                style={{ marginBottom: 2 }}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Main area ────────────────────────────────────────── */}
      <div
        id="main-area"
        className={sidebarCollapsed ? 'collapsed' : ''}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          height: '100vh',   /* exact viewport height — no overflow */
          overflow: 'hidden',
        }}
      >
        {/* Top header */}
        <header style={{
          height: 'var(--header-h)',
          background: 'var(--surface-1)',
          borderBottom: '1px solid var(--surface-4)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: 12,
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          zIndex: 20,
        }}>
          {/* Hamburger — mobile only */}
          <button
            className="btn-icon"
            id="hamburger"
            onClick={() => setMobileMenuOpen(true)}
            style={{ display: 'none' }}
          >
            <Menu size={20} />
          </button>

          {/* Shield logo — mobile */}
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            background: 'var(--blue-500)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
            id="mobile-logo"
          >
            <Shield size={16} color="#fff" />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ fontSize: 15, fontWeight: 700, margin: 0, lineHeight: 1.2, letterSpacing: '-0.01em' }}>
              {currentPage?.label}
            </h1>
          </div>

          {/* Docker status chip */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--surface-4)',
            borderRadius: 100,
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}>
            <span className="status-dot success pulse-dot" />
            <span style={{ display: 'none' }} id="status-label">Online</span>
          </div>
        </header>

        {/* Page content — the ONLY scrollable area */}
        <main
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '20px',
          }}
          id="page-content"
        >
          <div className="animate-fade-up">
            {active === 'dashboard'  && <Dashboard onNavigate={id => setActive(id as TabId)} />}
            {active === 'policies'   && <PolicyList />}
            {active === 'stacks'     && <StacksPage />}
            {active === 'history'    && <BackupHistory />}
            {active === 'verify'     && <VerifyHistory />}
            {active === 'storage'    && <VaultList />}
            {active === 'connectors' && <ConnectorsPage />}
            {active === 'audit'      && <SecurityAudit />}
            {active === 'settings'   && <SettingsPage />}
          </div>
        </main>

        {/* Bottom nav — mobile only */}
        <nav className="bottom-nav" id="bottom-nav" style={{ display: 'none' }}>
          {BOTTOM_NAV.map(item => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={`bottom-nav-item ${active === item.id ? 'active' : ''}`}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </button>
          ))}
          {/* More button */}
          <button
            className={`bottom-nav-item ${MORE_NAV.some(n => n.id === active) ? 'active' : ''}`}
            onClick={() => setMobileMenuOpen(true)}
          >
            <Menu size={20} />
            <span>More</span>
          </button>
        </nav>
      </div>

      {/* ── Responsive CSS via style tag ─────────────────────── */}
      <style>{`
        /* Desktop ≥1024px: full sidebar */
        @media (min-width: 1024px) {
          #sidebar-desktop {
            display: flex !important;
            width: var(--sidebar-full);
          }
          #sidebar-desktop.icon-only {
            width: var(--sidebar-icon);
          }
          #main-area {
            margin-left: var(--sidebar-full);
            transition: margin-left 0.2s ease;
          }
          #main-area.collapsed {
            margin-left: var(--sidebar-icon);
          }
          #hamburger { display: none !important; }
          #mobile-logo { display: none !important; }
          #bottom-nav { display: none !important; }
          #mobile-overlay { display: none !important; }
          #status-label { display: inline !important; }
        }

        /* Tablet 768–1023px: icon-only sidebar */
        @media (min-width: 768px) and (max-width: 1023px) {
          #sidebar-desktop {
            display: flex !important;
            width: var(--sidebar-icon) !important;
          }
          #main-area {
            margin-left: var(--sidebar-icon);
          }
          #hamburger { display: none !important; }
          #mobile-logo { display: none !important; }
          #bottom-nav { display: none !important; }
          #mobile-overlay { display: none !important; }
        }

        /* Mobile ≤767px: hamburger + bottom nav */
        @media (max-width: 767px) {
          #sidebar-desktop { display: none !important; }
          #main-area { margin-left: 0; padding-bottom: var(--bottom-nav-h); }
          #hamburger { display: flex !important; }
          #mobile-logo { display: flex !important; }
          #bottom-nav { display: flex !important; }
          #mobile-overlay { display: block !important; }
          #page-content { padding: 12px !important; }
        }
      `}</style>
    </div>
  )
}

const App: React.FC = () => (
  <ToastProvider>
    <MainApp />
  </ToastProvider>
)

export default App
