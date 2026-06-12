import React, { useEffect, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'

/**
 * SortableGrid — a dependency-free, reorderable widget grid.
 *
 * Why hand-rolled instead of dnd-kit / react-grid-layout: this repo ships a
 * carefully reproducible cross-platform Docker build (see the optionalDependencies
 * note in packages/extension/package.json). A pure-pointer implementation keeps the
 * lockfile and bundle untouched while still giving correct mouse / touch / pen
 * behaviour (Pointer Events) plus keyboard reordering for accessibility.
 *
 * Layout: a `columns`-track CSS grid. Each widget declares a `span`. Below
 * `narrowBelow` (measured on the grid itself, so it reacts to sidebar resizing —
 * not just window size) every widget collapses to a single full-width column.
 *
 * Reordering: dragging a widget's grip live-reorders the `order` array as the
 * pointer crosses other widgets, mirroring how modern sortables feel. The parent
 * owns the order (and its persistence); we only emit `onReorder`.
 */
export interface SortableWidget {
  id: string
  /** Column span out of `columns` on wide layouts. Clamped to `columns`. */
  span: number
  node: React.ReactNode
  /** Accessible label for the drag handle, e.g. "Backup trends chart". */
  label: string
}

interface SortableGridProps {
  /** Widgets already in display order (parent applies the order array). */
  widgets: SortableWidget[]
  onReorder: (orderedIds: string[]) => void
  columns?: number
  gap?: number
  /** Grid width (px) at/under which everything stacks to one column. */
  narrowBelow?: number
}

export const SortableGrid: React.FC<SortableGridProps> = ({
  widgets,
  onReorder,
  columns = 12,
  gap = 12,
  narrowBelow = 720,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [dragId, setDragId] = useState<string | null>(null)
  const [narrow, setNarrow] = useState(false)

  // Keep the live order in a ref so pointer handlers always see the latest value
  // without being re-created every render.
  const orderRef = useRef<string[]>(widgets.map(w => w.id))
  orderRef.current = widgets.map(w => w.id)

  // React to the grid's own width (covers window resize AND sidebar resize).
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      setNarrow(w > 0 && w < narrowBelow)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [narrowBelow])

  // Compute where the dragged widget should land from the pointer position,
  // by comparing against the *centers* of the other widgets in reading order
  // (top→bottom, then left→right). This is monotonic in pointer position, so it
  // stays stable even when widgets have different spans — no swap-back jitter,
  // and it also works when the pointer is in a gap between cards.
  const insertionIndex = (x: number, y: number): number => {
    const others = orderRef.current.filter(id => id !== dragId)
    for (let i = 0; i < others.length; i++) {
      const el = itemRefs.current.get(others[i])
      if (!el) continue
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const rowTol = r.height / 2
      const pastInReadingOrder =
        cy > y + rowTol || (Math.abs(cy - y) <= rowTol && cx > x)
      if (pastInReadingOrder) return i
    }
    return others.length
  }

  const reorderFromPointer = (x: number, y: number) => {
    if (!dragId) return
    const cur = orderRef.current
    const next = cur.filter(id => id !== dragId)
    next.splice(insertionIndex(x, y), 0, dragId)
    if (next.join('|') !== cur.join('|')) onReorder(next)
  }

  const onGripPointerDown = (id: string) => (e: React.PointerEvent) => {
    // Left button / touch / pen only.
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* capture is best-effort */
    }
    setDragId(id)
  }

  const onGripPointerMove = (e: React.PointerEvent) => {
    if (!dragId) return
    reorderFromPointer(e.clientX, e.clientY)
  }

  const endDrag = (e: React.PointerEvent) => {
    if (!dragId) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* no-op */
    }
    setDragId(null)
  }

  // Keyboard reordering: focus a grip, arrow keys swap with neighbours.
  const swap = (id: string, delta: number) => {
    const cur = orderRef.current
    const i = cur.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= cur.length) return
    const next = [...cur]
    ;[next[i], next[j]] = [next[j], next[i]]
    onReorder(next)
  }

  const onGripKeyDown = (id: string) => (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      swap(id, -1)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      swap(id, +1)
    }
  }

  return (
    <div
      ref={containerRef}
      className="sortable-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap,
        alignItems: 'start',
      }}
    >
      {widgets.map((w, idx) => {
        const span = narrow ? columns : Math.min(Math.max(1, w.span), columns)
        const dragging = dragId === w.id
        return (
          <div
            key={w.id}
            ref={el => {
              if (el) itemRefs.current.set(w.id, el)
              else itemRefs.current.delete(w.id)
            }}
            className={`widget${dragging ? ' dragging' : ''}`}
            style={{
              gridColumn: `span ${span}`,
              ...(dragging
                ? { zIndex: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.45)', borderRadius: 12 }
                : {}),
            }}
          >
            <button
              type="button"
              className="widget-grip"
              title="Drag to rearrange — or focus and use arrow keys"
              aria-label={`Reorder ${w.label}. Panel ${idx + 1} of ${widgets.length}. Use arrow keys to move.`}
              onPointerDown={onGripPointerDown(w.id)}
              onPointerMove={onGripPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onGripKeyDown(w.id)}
            >
              <GripVertical size={15} />
            </button>
            {w.node}
          </div>
        )
      })}
    </div>
  )
}
