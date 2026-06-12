/**
 * useGuardStream — global SSE subscription for /api/guard/stream.
 *
 * Lifecycle: mount once at the app root (inside App.tsx). Silently does
 * nothing if the backend returns 404 (PG-1.4 not deployed yet) or any other
 * connection error — no toasts, no console spam on 404.
 *
 * SSE frame shapes (per §9):
 *   event: snapshot  data: { id, kind, volumes:[{volume,status,sizeBytes}] }
 *   event: too_late  data: { id, volume, floorSnapshotAgeHours }
 *   event: warning   data: { id, volume, reason }   (logged only, no UI)
 *
 * The hook drives the GuardToastContainer by returning a list of pending
 * frames and a dismiss handler.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getGuardStreamUrl } from '../api'
import type { GuardFrame } from '../components/GuardToast'

const RECONNECT_DELAY_MS = 5000

export function useGuardStream(): {
  frames: GuardFrame[]
  dismiss: (id: string) => void
} {
  const [frames, setFrames] = useState<GuardFrame[]>([])
  const esRef = useRef<EventSource | null>(null)
  const abortRef = useRef(false)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dismiss = useCallback((id: string) => {
    setFrames(prev => prev.filter(f => f.id !== id))
  }, [])

  useEffect(() => {
    abortRef.current = false

    function connect() {
      if (abortRef.current) return

      const url = getGuardStreamUrl()
      const es = new EventSource(url)
      esRef.current = es

      // snapshot frame → push to pending banners
      es.addEventListener('snapshot', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          const frame: GuardFrame = {
            kind: 'snapshot',
            id: data.id,
            opKind: data.kind ?? data.opKind,
            volumes: data.volumes ?? [],
          }
          setFrames(prev => {
            // deduplicate by id
            if (prev.some(f => f.id === frame.id)) return prev
            return [...prev, frame]
          })
        } catch {
          // malformed frame — ignore
        }
      })

      // too_late frame → push to pending banners
      es.addEventListener('too_late', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          const frame: GuardFrame = {
            kind: 'too_late',
            id: data.id,
            volume: data.volume,
            floorSnapshotAgeHours: data.floorSnapshotAgeHours ?? 0,
          }
          setFrames(prev => {
            if (prev.some(f => f.id === frame.id)) return prev
            return [...prev, frame]
          })
        } catch {
          // malformed frame — ignore
        }
      })

      // warning frames: just log at debug level (no UI per spec)
      es.addEventListener('warning', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.debug('[guard:warning]', data)
          }
        } catch {
          // ignore
        }
      })

      es.onerror = () => {
        es.close()
        esRef.current = null
        // 404 = backend not deployed (PG-1.4 missing). Other errors = transient.
        // In both cases we don't surface anything to the user, but we back off
        // before retrying to avoid hammering the server or flooding the console.
        if (!abortRef.current) {
          reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
        }
      }
    }

    connect()

    return () => {
      abortRef.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
    }
  }, [])

  return { frames, dismiss }
}
