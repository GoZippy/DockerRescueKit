import { BackupPolicy, Backup, ConnectorInstance, ConnectorDefinition } from '@docker-rescue-kit/shared'
import { apiClient, TRANSPORT } from './transport'

// Use import.meta.env directly (rather than the re-exported TRANSPORT const)
// so Vite's `define` substitution + esbuild minifier can constant-fold the
// branch and eliminate every `drk_api_key` reference from the extension bundle.

// Only used in tcp transport mode.
export function getApiKey(): string {
  if (import.meta.env.VITE_TRANSPORT === 'extension') return ''
  return localStorage.getItem('drk_api_key')
    || import.meta.env.VITE_API_KEY
    || ''
}

// Only used in tcp transport mode.
export function setApiKey(key: string): void {
  if (import.meta.env.VITE_TRANSPORT === 'extension') return
  localStorage.setItem('drk_api_key', key)
  window.location.reload()
}

// Only used in tcp transport mode.
export function clearApiKey(): void {
  if (import.meta.env.VITE_TRANSPORT === 'extension') return
  localStorage.removeItem('drk_api_key')
  window.location.reload()
}

// Single touch point for the API base URL. Future env-based overrides
// (e.g. VITE_API_BASE) only need to be plumbed through this function.
export function getApiBase(): string {
  return '/api'
}

// === API Definitions ===

export const getStatus = async () => {
  return apiClient.get<any>('/status')
}

export const getPolicies = async (): Promise<BackupPolicy[]> => {
  return apiClient.get<BackupPolicy[]>('/policies')
}

export const createPolicy = async (policyData: any): Promise<BackupPolicy> => {
  return apiClient.post<BackupPolicy>('/policies', policyData)
}

export const updatePolicy = async (id: string, policyData: any): Promise<BackupPolicy> => {
  return apiClient.put<BackupPolicy>(`/policies/${id}`, policyData)
}

export const deletePolicy = async (id: string) => {
  return apiClient.delete<any>(`/policies/${id}`)
}

export const runPolicy = async (id: string) => {
  return apiClient.post<any>(`/policies/${id}/run`)
}

export const getPolicyHistory = async (id: string): Promise<Backup[]> => {
  return apiClient.get<Backup[]>(`/policies/${id}/history`)
}

export const listAllBackups = async (): Promise<Backup[]> => {
  return apiClient.get<Backup[]>('/backups')
}

export const getBackup = async (id: string): Promise<Backup> => {
  return apiClient.get<Backup>(`/backups/${id}`)
}

export const restoreBackup = async (
  id: string,
  opts: { dryRun?: boolean; targetOverrides?: any } = {}
) => {
  return apiClient.post<any>(`/backups/${id}/restore`, opts)
}

export const deleteBackup = async (id: string) => {
  return apiClient.delete<any>(`/backups/${id}`)
}

export const listStacks = async () => {
  return apiClient.get<any>('/docker/stacks')
}

export const listBackupFiles = async (backupId: string, fileName: string) => {
  return apiClient.get<Array<{ path: string; size: number; mode: string; mtime?: string }>>(
    `/backups/${backupId}/files`,
    { name: fileName }
  )
}

export const extractBackupFileUrl = (backupId: string, fileName: string, entryPath: string) => {
  const q = new URLSearchParams({ name: fileName, path: entryPath }).toString()
  if (import.meta.env.VITE_TRANSPORT === 'extension') {
    // Extension mode: ddClient handles auth; no apiKey query param required.
    return `/api/backups/${backupId}/files/extract?${q}`
  }
  return `/api/backups/${backupId}/files/extract?${q}&apiKey=${encodeURIComponent(getApiKey())}`
}

export const verifyBackup = async (backupId: string) => {
  return apiClient.post<any>(`/backups/${backupId}/verify`)
}

export const listVerifyHistory = async () => {
  return apiClient.get<Array<{
    id: string
    backupId: string
    policyId: string
    ok: boolean
    startedAt: string
    finishedAt: string
    durationMs: number
    steps: Array<{ label: string; ok: boolean; detail?: string }>
  }>>('/verify-history')
}

export const verifyPolicy = async (policyId: string) => {
  return apiClient.post<any>(`/policies/${policyId}/verify`)
}

export const listImages = async () => {
  return apiClient.get<any>('/docker/images')
}

export const listNetworks = async () => {
  return apiClient.get<any>('/docker/networks')
}

export const getAuditLog = async () => {
  return apiClient.get<Array<{
    id: string
    timestamp: string
    action: string
    details?: string
    user?: string
  }>>('/audit')
}

export const regenerateApiKey = async () => {
  return apiClient.post<{ apiKey: string }>('/settings/regenerate-api-key')
}

export const getSettingsMeta = async () => {
  return apiClient.get<{ dataDir: string; hasEncryptionKey: boolean; version: string; staging: string }>(
    '/settings/meta'
  )
}

export const pauseScheduler = async () => {
  return apiClient.post<any>('/scheduler/pause')
}

export const resumeScheduler = async () => {
  return apiClient.post<any>('/scheduler/resume')
}

// ── Rclone remote management ──────────────────────────────────────────
export const getRcloneProviders = async () => {
  return apiClient.get<Array<{
    id: string; name: string; description: string
    authType: 'oauth' | 'key' | 'none'; icon: string
    fields: Array<{ name: string; label: string; type: string; required: boolean; placeholder?: string; description?: string }>
  }>>('/rclone/providers')
}

export const getRcloneRemotes = async () => {
  return apiClient.get<Array<{ name: string; type: string; configured: boolean }>>('/rclone/remotes')
}

export const createRcloneRemote = async (name: string, providerType: string, params: Record<string, string>) => {
  return apiClient.post<any>('/rclone/remotes', { name, providerType, params })
}

export const deleteRcloneRemote = async (name: string) => {
  await apiClient.delete<any>(`/rclone/remotes/${encodeURIComponent(name)}`)
}

export const testRcloneRemote = async (name: string) => {
  return apiClient.post<{ ok: boolean; error?: string }>(`/rclone/remotes/${encodeURIComponent(name)}/test`)
}

export const startRcloneOAuth = async (sessionId: string, providerType: string) => {
  return apiClient.post<{ url: string }>('/rclone/oauth/start', { sessionId, providerType })
}

export const pollRcloneOAuthToken = async (sessionId: string) => {
  return apiClient.get<{ token: string | null }>(`/rclone/oauth/token/${sessionId}`)
}

export const finishRcloneOAuth = async (sessionId: string, remoteName: string, providerType: string, token: string) => {
  return apiClient.post<any>('/rclone/oauth/finish', { sessionId, remoteName, providerType, token })
}

export const cancelRcloneOAuth = async (sessionId: string) => {
  await apiClient.post<any>('/rclone/oauth/cancel', { sessionId })
}

export const protectStack = async (project: string) => {
  return apiClient.post<any>(`/docker/stacks/${encodeURIComponent(project)}/protect`)
}

export const getContainers = async () => {
  return apiClient.get<any>('/docker/containers')
}

export const getVolumes = async () => {
  return apiClient.get<any>('/docker/volumes')
}

export const getConnectors = async (): Promise<ConnectorDefinition[]> => {
  return apiClient.get<ConnectorDefinition[]>('/connectors/definitions')
}

export const getConnectorInstances = async (): Promise<ConnectorInstance[]> => {
  return apiClient.get<ConnectorInstance[]>('/connectors')
}

export const saveConnectorInstance = async (connector: Partial<ConnectorInstance>) => {
  return apiClient.post<any>('/connectors', connector)
}

export const deleteConnectorInstance = async (id: string) => {
  return apiClient.delete<any>(`/connectors/${id}`)
}

export const getTelemetry = async () => {
  return apiClient.get<any>('/system/telemetry')
}

export const getSetting = async (key: string): Promise<string | null> => {
  const res = await apiClient.get<{ value: string | null }>(`/settings/${key}`)
  return res.value
}

export const saveSetting = async (key: string, value: string) => {
  return apiClient.post<any>(`/settings/${key}`, { value })
}

export const testConnector = async (type: string, config: any) => {
  return apiClient.post<any>('/connectors/test', { type, config })
}

export const discoverConnector = async (type: string, config: any) => {
  return apiClient.post<any>('/connectors/discover', { type, config })
}

// ── Restore-rehearsal workflow (R-2) ──────────────────────────────────────

export const listRehearsals = async (opts?: { policyId?: string; limit?: number }) => {
  const params = new URLSearchParams()
  if (opts?.policyId) params.set('policyId', opts.policyId)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const q = params.toString()
  return apiClient.get<Array<{
    id: string
    policyId?: string
    status: string
    ok: boolean
    startedAt: string
    finishedAt?: string
    durationMs?: number
  }>>(`/rehearsals${q ? '?' + q : ''}`)
}

export const getRehearsalReport = async (id: string) => {
  return apiClient.get<any>(`/rehearsals/${id}`)
}

export const startRehearsal = async (payload: {
  policyId?: string
  backupIds?: string[]
  smokeChecks: any[]
  options?: {
    stopOnFirstCheckFailure?: boolean
    networkSubnet?: string
    timeoutMs?: number
    allowEnvVars?: string[]
  }
}) => {
  return apiClient.post<{ id: string; status: string }>('/rehearsals', payload)
}

export const abortRehearsal = async (id: string) => {
  return apiClient.post<any>(`/rehearsals/${id}/abort`)
}

export const deleteRehearsal = async (id: string) => {
  return apiClient.delete<any>(`/rehearsals/${id}`)
}

export const getRehearsalStreamUrl = (id: string) => {
  if (import.meta.env.VITE_TRANSPORT === 'extension') {
    return `/api/rehearsals/${id}/stream`
  }
  return `/api/rehearsals/${id}/stream?apiKey=${encodeURIComponent(getApiKey())}`
}
