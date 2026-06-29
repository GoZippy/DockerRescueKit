import React, { useState, useEffect, useRef, Suspense } from 'react'
const Dashboard = React.lazy(() => import('./components/Dashboard').then(m => ({ default: m.Dashboard })))
const VaultList = React.lazy(() => import('./components/VaultList').then(m => ({ default: m.VaultList })))
const SecurityAudit = React.lazy(() => import('./components/SecurityAudit').then(m => ({ default: m.SecurityAudit })))
const PolicyList = React.lazy(() => import('./components/PolicyList').then(m => ({ default: m.PolicyList })))
const ConnectorsPage = React.lazy(() => import('./components/ConnectorsPage').then(m => ({ default: m.ConnectorsPage })))
const BackupHistory = React.lazy(() => import('./components/BackupHistory').then(m => ({ default: m.BackupHistory })))
const VerifyHistory = React.lazy(() => import('./components/VerifyHistory').then(m => ({ default: m.VerifyHistory })))
const SettingsPage = React.lazy(() => import('./components/SettingsPage').then(m => ({ default: m.SettingsPage })))
const StacksPage = React.lazy(() => import('./components/StacksPage').then(m => ({ default: m.StacksPage })))
const SetupScreen = React.lazy(() => import('./components/SetupScreen').then(m => ({ default: m.SetupScreen })))
const RehearsalsPage = React.lazy(() => import('./components/RehearsalsPage').then(m => ({ default: m.RehearsalsPage })))
const CostAnalysisPage = React.lazy(() => import('./components/CostAnalysisPage').then(m => ({ default: m.CostAnalysisPage })))
const NotificationsPage = React.lazy(() => import('./components/NotificationsPage').then(m => ({ default: m.NotificationsPage })))
const PruneGuardPage = React.lazy(() => import('./components/PruneGuardPage').then(m => ({ default: m.PruneGuardPage })))
import { VersionBadge } from './components/VersionBadge'
import { FeedbackModal } from './components/FeedbackModal'
import { getApiKey, getStatus, getSettingsMeta, getNotificationUnreadCount, isPaymentRequired } from './api'
import { ToastProvider } from './hooks/useToast'
import { useBreakpoint } from './hooks/useBreakpoint'
import { GuardToastContainer } from './components/GuardToast'
import { useGuardStream } from './hooks/useGuardStream'
import {
  Activity, Database, Layers, Clock, ShieldCheck,
  Server, Plug, Shield, Settings, Menu, X, ChevronLeft, TrendingUp,
  Loader2, Bell, RotateCcw,
  type LucideProps,
} from 'lucide-react'

const PageFallback = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
    <Loader2 size={24} className="animate-spin" />
  </div>
)

type TabId =
  | 'dashboard' | 'policies' | 'stacks' | 'history' | 'verify' | 'rehearsals' | 'guard' | 'costs'
  | 'storage' | 'connectors' | 'audit' | 'notifications' | 'settings'

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
  { id: 'rehearsals', label: 'Rehearsals',        icon: ShieldCheck, bottomNav: false },
  { id: 'guard',      label: 'Prune Guard',       icon: RotateCcw,   bottomNav: false },
  { id: 'costs',      label: 'Cost Analysis',     icon: TrendingUp,  bottomNav: false },
  { id: 'storage',    label: 'Storage Vault',    icon: Server,      bottomNav: false },
  { id: 'connectors', label: 'Integrations',     icon: Plug,        bottomNav: false },
  { id: 'audit',      label: 'Security Audit',   icon: Shield,      bottomNav: false },
  { id: 'notifications', label: 'Notifications', icon: Bell,        bottomNav: false },
  { id: 'settings',   label: 'Settings',         icon: Settings,    bottomNav: false },
]

const BOTTOM_NAV = NAV.filter(n => n.bottomNav)
const MORE_NAV = NAV.filter(n => !n.bottomNav)

// ── Sidebar sizing ───────────────────────────────────────────
const ICON_W = 72          // icon-only rail
const MIN_W = 200          // narrowest the user can drag the expanded sidebar
const MAX_W = 420          // widest
const DEFAULT_W = 240
const COLLAPSE_SNAP = 160  // drag below this on release → snap to icon-only rail

const LS_WIDTH = 'drk.sidebar.width'
const LS_ICON_ONLY = 'drk.sidebar.iconOnly'

const clampWidth = (w: number) => Math.min(MAX_W, Math.max(MIN_W, w))

const MainApp: React.FC = () => {
  const bp = useBreakpoint()
  const isMobile = bp === 'mobile'
  const isTablet = bp === 'tablet'
  const isDesktop = bp === 'desktop'

  const [active, setActive] = useState<TabId>('dashboard')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [dockerOnline, setDockerOnline] = useState<boolean | null>(null)
  const [deepLinkPolicyId, setDeepLinkPolicyId] = useState<string | undefined>()
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [installMeta, setInstallMeta] = useState<{ version?: string; dataDir?: string }>({})
  // Unread-notifications badge. null = unknown / not entitled (Free tier 402 or
  // backend too old) → we render the bell without a badge and never error.
  const [unread, setUnread] = useState<number | null>(null)
  const refreshUnread = React.useCallback(async () => {
    try {
      setUnread(await getNotificationUnreadCount())
    } catch (e) {
      // 402 (Free tier), 404 (older backend), or offline → no badge, no noise.
      if (isPaymentRequired(e)) setUnread(null)
      else setUnread(null)
    }
  }, [])

  // Sidebar preferences (desktop only) — persisted so they survive reloads.
  const [iconOnly, setIconOnly] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_ICON_ONLY) === '1' } catch { return false }
  })
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(LS_WIDTH) || '', 10)
      return Number.isFinite(v) ? clampWidth(v) : DEFAULT_W
    } catch { return DEFAULT_W }
  })
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(false)

  useEffect(() => {
    try { localStorage.setItem(LS_ICON_ONLY, iconOnly ? '1' : '0') } catch { /* private mode */ }
  }, [iconOnly])
  useEffect(() => {
    try { localStorage.setItem(LS_WIDTH, String(sidebarWidth)) } catch { /* private mode */ }
  }, [sidebarWidth])

  useEffect(() => {
    const check = async () => {
      try {
        const s = await getStatus()
        setDockerOnline(s?.docker ?? null)
      } catch {
        setDockerOnline(false)
      }
    }
    check()
    const interval = setInterval(check, 15000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    getSettingsMeta()
      .then(m => setInstallMeta({ version: m?.version, dataDir: m?.dataDir }))
      .catch(() => { /* best-effort */ })
  }, [])

  // Poll the unread-notifications badge ~every 60s. Degrades silently on
  // Free tier (402) / older backends (404) — no badge, no console errors.
  useEffect(() => {
    refreshUnread()
    const interval = setInterval(refreshUnread, 60000)
    return () => clearInterval(interval)
  }, [refreshUnread])

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

  // Derived layout state — one source of truth (the breakpoint), so labels and
  // width can never disagree (no more "Dash / Back / Com…" clipping).
  const rail = isTablet || (isDesktop && iconOnly) // icon-only display
  const showLabels = isDesktop && !iconOnly
  const asideWidth = rail ? ICON_W : sidebarWidth

  // ── Sidebar resize (desktop, expanded only) ────────────────
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault()
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* best-effort */ }
    resizingRef.current = true
    setResizing(true)
  }
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizingRef.current) return
    // The sidebar's left edge sits at viewport x=0, so pointer X ≈ desired width.
    setSidebarWidth(clampWidth(e.clientX))
  }
  const onResizeUp = (e: React.PointerEvent) => {
    if (!resizingRef.current) return
    resizingRef.current = false
    setResizing(false)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* best-effort */ }
    // Dragging the handle nearly shut collapses to the icon rail.
    if (e.clientX < COLLAPSE_SNAP) setIconOnly(true)
  }

  const renderNav = (onClick: (id: TabId) => void, withLabels: boolean) =>
    NAV.map(item => (
      <button
        key={item.id}
        onClick={() => onClick(item.id)}
        className={`sidebar-item ${active === item.id ? 'active' : ''}`}
        title={!withLabels ? item.label : undefined}
        style={{ marginBottom: 2, justifyContent: withLabels ? 'flex-start' : 'center' }}
      >
        <item.icon size={18} />
        {withLabels && <span>{item.label}</span>}
      </button>
    ))

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      overflow: 'hidden',
      background: 'var(--surface-0)',
      // While dragging the sidebar edge, suppress text selection + show the
      // resize cursor everywhere so the gesture feels solid.
      userSelect: resizing ? 'none' : undefined,
      cursor: resizing ? 'col-resize' : undefined,
    }}>

      {/* ── Sidebar — in-flow on tablet/desktop ─────────────── */}
      {!isMobile && (
        <aside
          className="sidebar"
          style={{
            position: 'relative',
            width: asideWidth,
            flexShrink: 0,
            height: '100%',
            // Override .sidebar's overflow:hidden so the edge resize handle isn't
            // clipped. Inner sections (logo, nav) clip their own overflow.
            overflow: 'visible',
            transition: resizing ? 'none' : 'width 0.18s ease',
          }}
        >
          {/* Logo */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '16px 14px 12px',
            borderBottom: '1px solid var(--surface-4)',
            flexShrink: 0,
            overflow: 'hidden',
            justifyContent: showLabels ? 'flex-start' : 'center',
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: 'var(--blue-500)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <Shield size={18} color="#fff" />
            </div>
            {showLabels && (
              <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
                RescueKit
              </span>
            )}
          </div>

          {/* Nav items */}
          <nav style={{ flex: 1, padding: '8px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
            {renderNav(navigate, showLabels)}
          </nav>

          {/* Version badge — hidden when collapsed to a rail (non-invasive) */}
          {showLabels && (
            <VersionBadge
              onOpenSettings={() => navigate('settings')}
              onOpenFeedback={() => setFeedbackOpen(true)}
            />
          )}

          {/* Collapse toggle — desktop only (tablet is always a rail) */}
          {isDesktop && (
            <button
              onClick={() => setIconOnly(c => !c)}
              className="btn-icon"
              style={{
                margin: '8px',
                width: rail ? 48 : 'calc(100% - 16px)',
                justifyContent: rail ? 'center' : 'flex-end',
              }}
              title={iconOnly ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <ChevronLeft
                size={16}
                style={{ transform: iconOnly ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }}
              />
            </button>
          )}

          {/* Drag-to-resize handle — desktop, expanded only */}
          {isDesktop && !iconOnly && (
            <div
              className={`resize-handle ${resizing ? 'active' : ''}`}
              onPointerDown={onResizeDown}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
              onPointerCancel={onResizeUp}
              onKeyDown={e => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); setSidebarWidth(w => clampWidth(w - 16)) }
                else if (e.key === 'ArrowRight') { e.preventDefault(); setSidebarWidth(w => clampWidth(w + 16)) }
                else if (e.key === 'Enter') { e.preventDefault(); setIconOnly(true) }
              }}
              tabIndex={0}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar — arrow keys to resize, Enter to collapse"
              aria-valuenow={sidebarWidth}
              title="Drag to resize · drag fully left to collapse"
            />
          )}
        </aside>
      )}

      {/* ── Mobile overlay drawer ────────────────────────────── */}
      {isMobile && mobileMenuOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 40 }}
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
            {renderNav(navigate, true)}
            <div style={{ marginTop: 12, borderTop: '1px solid var(--surface-4)', paddingTop: 8 }}>
              <VersionBadge
                compact
                onOpenSettings={() => navigate('settings')}
                onOpenFeedback={() => setFeedbackOpen(true)}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Main area ────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          height: '100vh',
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
          zIndex: 20,
        }}>
          {/* Hamburger + logo — mobile only */}
          {isMobile && (
            <>
              <button className="btn-icon" onClick={() => setMobileMenuOpen(true)} aria-label="Open menu">
                <Menu size={20} />
              </button>
              <div style={{
                width: 28, height: 28, borderRadius: 6,
                background: 'var(--blue-500)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Shield size={16} color="#fff" />
              </div>
            </>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ fontSize: 15, fontWeight: 700, margin: 0, lineHeight: 1.2, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {currentPage?.label}
            </h1>
          </div>

          {/* Notifications bell + unread badge. Clicking opens the page;
              the badge is hidden when count is null (Free tier / older backend)
              or zero. */}
          <button
            className="btn-icon"
            onClick={() => navigate('notifications')}
            aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
            title="Notifications"
            style={{ position: 'relative', flexShrink: 0 }}
          >
            <Bell size={18} />
            {unread != null && unread > 0 && (
              <span
                style={{
                  position: 'absolute', top: 2, right: 2,
                  minWidth: 16, height: 16, padding: '0 4px',
                  borderRadius: 8, background: 'var(--blue-500)', color: '#fff',
                  fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
                }}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>

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
            <span className={`status-dot ${dockerOnline === null ? 'idle' : dockerOnline ? 'success pulse-dot' : 'failed'}`} />
            {!isMobile && (
              <span>
                {dockerOnline === null ? 'Connecting' : dockerOnline ? 'Online' : 'Offline'}
              </span>
            )}
          </div>
        </header>

        {/* Page content — the ONLY scrollable area */}
        <main
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: isMobile ? 12 : 20,
            paddingBottom: isMobile ? 'calc(var(--bottom-nav-h) + 12px)' : 20,
          }}
        >
          <Suspense fallback={<PageFallback />}>
          <div className="animate-fade-up">
            {active === 'dashboard'  && <Dashboard onNavigate={id => setActive(id as TabId)} />}
            {active === 'policies'   && <PolicyList initialPolicyId={deepLinkPolicyId} />}
            {active === 'stacks'     && (
              <StacksPage onEditPolicy={p => {
                setDeepLinkPolicyId(p.id)
                setActive('policies')
                setMobileMenuOpen(false)
              }} />
            )}
            {active === 'history'    && <BackupHistory />}
            {active === 'verify'     && <VerifyHistory />}
            {active === 'rehearsals' && <RehearsalsPage />}
            {active === 'guard'      && <PruneGuardPage />}
            {active === 'costs'      && <CostAnalysisPage />}
            {active === 'storage'    && <VaultList />}
            {active === 'connectors' && <ConnectorsPage />}
            {active === 'audit'      && <SecurityAudit />}
            {active === 'notifications' && <NotificationsPage onUnreadChange={refreshUnread} />}
            {active === 'settings'   && <SettingsPage />}
          </div>
          </Suspense>
        </main>

        {/* Bottom nav — mobile only */}
        {isMobile && (
          <nav className="bottom-nav">
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
            <button
              className={`bottom-nav-item ${MORE_NAV.some(n => n.id === active) ? 'active' : ''}`}
              onClick={() => setMobileMenuOpen(true)}
            >
              <Menu size={20} />
              <span>More</span>
            </button>
          </nav>
        )}
      </div>

      {/* ── Feedback modal (mounted at root so it overlays everything) ── */}
      <FeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        context={{
          page: currentPage?.label,
          version: installMeta.version,
          dataDir: installMeta.dataDir,
        }}
      />
    </div>
  )
}

/**
 * GuardStreamHost — subscribes to /api/guard/stream (once, app-level) and
 * renders the action-capable GuardToastContainer.
 *
 * Must live INSIDE <ToastProvider> so the GuardBanner actions can push plain
 * success/error toasts via useToast.
 *
 * Silently does nothing when the backend is not yet deployed (404 on the
 * SSE endpoint degrades to a silent reconnect loop with no UI noise).
 */
const GuardStreamHost: React.FC = () => {
  const { frames, dismiss } = useGuardStream()
  return <GuardToastContainer frames={frames} onDismiss={dismiss} />
}

const App: React.FC = () => (
  <ToastProvider>
    <GuardStreamHost />
    <MainApp />
  </ToastProvider>
)

export default App
