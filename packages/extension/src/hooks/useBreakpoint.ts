import { useEffect, useState } from 'react'

/**
 * Layout breakpoints for the extension shell.
 *
 *   mobile  : < 768px   → hamburger drawer + bottom nav, no in-flow sidebar
 *   tablet  : 768–1023  → icon-only sidebar rail (labels hidden)
 *   desktop : ≥ 1024px  → full / user-resizable sidebar
 *
 * This hook is the SINGLE source of truth for which layout is active. Previously
 * the sidebar *width* was driven by CSS media queries while the label *text* was
 * driven by independent React state — so in the 768–1023 band CSS crushed the
 * rail to 72px while React still rendered full labels into it, clipping them to
 * "Dash / Back / Com…". Driving both from one value eliminates that desync.
 */
export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

// Ordered most-specific → least; first match wins. Upper bounds use .98 to avoid
// a dead zone at exact integer widths between adjacent queries.
const QUERIES: ReadonlyArray<readonly [Breakpoint, string]> = [
  ['desktop', '(min-width: 1024px)'],
  ['tablet', '(min-width: 768px) and (max-width: 1023.98px)'],
  ['mobile', '(max-width: 767.98px)'],
]

function resolve(): Breakpoint {
  if (typeof window === 'undefined' || !window.matchMedia) return 'desktop'
  for (const [bp, q] of QUERIES) {
    if (window.matchMedia(q).matches) return bp
  }
  return 'desktop'
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(resolve)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mqls = QUERIES.map(([, q]) => window.matchMedia(q))
    const onChange = () => setBp(resolve())
    mqls.forEach(m => m.addEventListener('change', onChange))
    // Re-sync once on mount in case width changed before listeners attached.
    onChange()
    return () => mqls.forEach(m => m.removeEventListener('change', onChange))
  }, [])

  return bp
}
