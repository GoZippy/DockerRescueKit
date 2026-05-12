import React, { createContext, useCallback, useContext, useState } from 'react'
import { Toast, ToastItem, ToastKind } from '../components/Toast'

interface ToastContextValue {
  push: (kind: ToastKind, message: string, timeout?: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

let _idCounter = 0
const nextId = () => `t_${Date.now().toString(36)}_${(++_idCounter).toString(36)}`

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const push = useCallback((kind: ToastKind, message: string, timeout?: number) => {
    setToasts(prev => [...prev, { id: nextId(), kind, message, timeout }])
  }, [])

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <Toast toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Fail-soft fallback: provider not wired yet. Log to console so the
    // call doesn't throw and break a page load. The orchestrator must
    // wrap the app tree with <ToastProvider> in App.tsx.
    return {
      push: (kind, message) => {
        // eslint-disable-next-line no-console
        console.warn(`[toast:${kind}] ${message} (ToastProvider not mounted)`)
      },
    }
  }
  return ctx
}
