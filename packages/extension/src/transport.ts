// Two transports. The build flag VITE_TRANSPORT (set in vite.config.ts) is
// "tcp" by default and "extension" when building for the Docker Desktop
// Marketplace.
import axios, { AxiosInstance } from 'axios'
import { createDockerDesktopClient } from '@docker/extension-api-client'

export type Transport = 'tcp' | 'extension'

export const TRANSPORT: Transport =
  (import.meta.env.VITE_TRANSPORT as Transport) ?? 'tcp'

export interface ApiClient {
  get<T>(path: string, params?: Record<string, unknown>): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  delete<T>(path: string): Promise<T>
}

// ── Shared helpers ────────────────────────────────────────────────────────
function appendQuery(path: string, params?: Record<string, unknown>): string {
  if (!params) return path
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  if (entries.length === 0) return path
  const qs = new URLSearchParams()
  for (const [k, v] of entries) qs.append(k, String(v))
  return path.includes('?') ? `${path}&${qs.toString()}` : `${path}?${qs.toString()}`
}

// ── TCP transport (existing behaviour) ────────────────────────────────────
//
// Built as a thunk so the entire setup (axios.create + interceptors + the
// `drk_api_key` localStorage references) DCEs out of the extension bundle.
// Only used in tcp transport mode.
function buildTcpClient(): ApiClient {
  function getApiKeyLocal(): string {
    return localStorage.getItem('drk_api_key')
      || import.meta.env.VITE_API_KEY
      || ''
  }
  function clearApiKeyLocal(): void {
    localStorage.removeItem('drk_api_key')
    window.location.reload()
  }

  const tcpAxios: AxiosInstance = axios.create({
    baseURL: '/api',
    headers: { 'Content-Type': 'application/json' },
  })

  // Dynamically inject the API key on every request so localStorage changes
  // take effect without requiring a manual page reload.
  tcpAxios.interceptors.request.use(config => {
    const key = getApiKeyLocal()
    if (key) {
      config.headers['x-api-key'] = key
    }
    return config
  })

  // On 401, the stored key is no longer valid (rotated, deleted, or wrong).
  // Clear it and bounce back to SetupScreen rather than letting every page
  // render in a broken auth state. clearApiKeyLocal() reloads the page.
  tcpAxios.interceptors.response.use(
    res => res,
    err => {
      if (err?.response?.status === 401) {
        if (getApiKeyLocal()) {
          clearApiKeyLocal()
        }
      }
      return Promise.reject(err)
    }
  )

  return {
    async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      const res = await tcpAxios.get<T>(path, params ? { params } : undefined)
      return res.data as T
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      const res = await tcpAxios.post<T>(path, body)
      return res.data as T
    },
    async put<T>(path: string, body?: unknown): Promise<T> {
      const res = await tcpAxios.put<T>(path, body)
      return res.data as T
    },
    async delete<T>(path: string): Promise<T> {
      const res = await tcpAxios.delete<T>(path)
      return res.data as T
    },
  }
}

// ── Extension transport (Docker Desktop IPC) ──────────────────────────────
//
// Routes requests through Docker Desktop's `ddClient.extension.vm.service`,
// which proxies to the backend container's Unix socket. No API key —
// Docker Desktop guarantees the channel.
function buildExtensionClient(): ApiClient {
  const ddClient = createDockerDesktopClient()
  const svc = () => ddClient.extension.vm!.service!
  // Mirror the TCP transport's axios baseURL so all paths resolve under /api
  const prefix = (path: string) => `/api${path}`

  function parseRes<T>(res: unknown): T {
    if (typeof res === 'string') {
      try { return JSON.parse(res) as T } catch {}
    }
    return res as T
  }

  return {
    async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      const url = appendQuery(prefix(path), params)
      const res = await svc().get(url)
      return parseRes<T>(res)
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      const res = await svc().post(prefix(path), body ?? {})
      return parseRes<T>(res)
    },
    async put<T>(path: string, body?: unknown): Promise<T> {
      const res = await svc().put(prefix(path), body ?? {})
      return parseRes<T>(res)
    },
    async delete<T>(path: string): Promise<T> {
      const res = await svc().delete(prefix(path))
      return parseRes<T>(res)
    },
  }
}

// ── Resolved client ───────────────────────────────────────────────────────
// Branch on `import.meta.env.VITE_TRANSPORT` directly so Vite's `define`
// substitution + esbuild constant-fold the unused builder + its references
// (notably the `drk_api_key` localStorage strings) out of the bundle.
export const apiClient: ApiClient =
  import.meta.env.VITE_TRANSPORT === 'extension' ? buildExtensionClient() : buildTcpClient()
