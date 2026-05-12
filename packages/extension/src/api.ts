import axios from 'axios'
import { BackupPolicy, Backup, ConnectorInstance, ConnectorDefinition } from '@docker-rescue-kit/shared'

export function getApiKey(): string {
  return localStorage.getItem('drk_api_key')
    || import.meta.env.VITE_API_KEY
    || ''
}

export function setApiKey(key: string): void {
  localStorage.setItem('drk_api_key', key)
  window.location.reload()
}

export function clearApiKey(): void {
  localStorage.removeItem('drk_api_key')
  window.location.reload()
}

// Single touch point for the API base URL. Future env-based overrides
// (e.g. VITE_API_BASE) only need to be plumbed through this function.
export function getApiBase(): string {
  return '/api'
}

export const apiClient = axios.create({
  baseURL: getApiBase(),
  headers: {
    'Content-Type': 'application/json'
  }
})

// Dynamically inject the API key on every request so localStorage changes
// take effect without requiring a manual page reload.
apiClient.interceptors.request.use(config => {
  const key = getApiKey()
  if (key) {
    config.headers['x-api-key'] = key
  }
  return config
})

// On 401, the stored key is no longer valid (rotated, deleted, or wrong).
// Clear it and bounce back to SetupScreen rather than letting every page
// render in a broken auth state. clearApiKey() reloads the page.
apiClient.interceptors.response.use(
  res => res,
  err => {
    if (err?.response?.status === 401) {
      // Avoid a reload loop if SetupScreen itself is somehow making API calls
      // (it shouldn't — but be defensive).
      if (getApiKey()) {
        clearApiKey()
      }
    }
    return Promise.reject(err)
  }
)

// === API Definitions ===

export const getStatus = async () => {
  const res = await apiClient.get('/status')
  return res.data
}

export const getPolicies = async (): Promise<BackupPolicy[]> => {
  const res = await apiClient.get('/policies')
  return res.data
}

export const createPolicy = async (policyData: any): Promise<BackupPolicy> => {
  const res = await apiClient.post('/policies', policyData)
  return res.data
}

export const updatePolicy = async (id: string, policyData: any): Promise<BackupPolicy> => {
  const res = await apiClient.put(`/policies/${id}`, policyData)
  return res.data
}

export const deletePolicy = async (id: string) => {
  const res = await apiClient.delete(`/policies/${id}`)
  return res.data
}

export const runPolicy = async (id: string) => {
  const res = await apiClient.post(`/policies/${id}/run`)
  return res.data
}

export const getPolicyHistory = async (id: string): Promise<Backup[]> => {
  const res = await apiClient.get(`/policies/${id}/history`)
  return res.data
}

export const listAllBackups = async (): Promise<Backup[]> => {
  const res = await apiClient.get('/backups')
  return res.data
}

export const getBackup = async (id: string): Promise<Backup> => {
  const res = await apiClient.get(`/backups/${id}`)
  return res.data
}

export const restoreBackup = async (
  id: string,
  opts: { dryRun?: boolean; targetOverrides?: any } = {}
) => {
  const res = await apiClient.post(`/backups/${id}/restore`, opts)
  return res.data
}

export const deleteBackup = async (id: string) => {
  const res = await apiClient.delete(`/backups/${id}`)
  return res.data
}

export const listStacks = async () => {
  const res = await apiClient.get('/docker/stacks')
  return res.data
}

export const listBackupFiles = async (backupId: string, fileName: string) => {
  const res = await apiClient.get(`/backups/${backupId}/files`, { params: { name: fileName } })
  return res.data as Array<{ path: string; size: number; mode: string; mtime?: string }>
}

export const extractBackupFileUrl = (backupId: string, fileName: string, entryPath: string) => {
  const q = new URLSearchParams({ name: fileName, path: entryPath }).toString()
  return `/api/backups/${backupId}/files/extract?${q}&apiKey=${encodeURIComponent(getApiKey())}`
}

export const verifyBackup = async (backupId: string) => {
  const res = await apiClient.post(`/backups/${backupId}/verify`)
  return res.data
}

export const listVerifyHistory = async () => {
  const res = await apiClient.get('/verify-history')
  return res.data as Array<{
    id: string
    backupId: string
    policyId: string
    ok: boolean
    startedAt: string
    finishedAt: string
    durationMs: number
    steps: Array<{ label: string; ok: boolean; detail?: string }>
  }>
}

export const verifyPolicy = async (policyId: string) => {
  const res = await apiClient.post(`/policies/${policyId}/verify`)
  return res.data
}

export const listImages = async () => {
  const res = await apiClient.get('/docker/images')
  return res.data
}

export const listNetworks = async () => {
  const res = await apiClient.get('/docker/networks')
  return res.data
}

export const getAuditLog = async () => {
  const res = await apiClient.get('/audit')
  return res.data as Array<{
    id: string
    timestamp: string
    action: string
    details?: string
    user?: string
  }>
}

export const regenerateApiKey = async () => {
  const res = await apiClient.post('/settings/regenerate-api-key')
  return res.data as { apiKey: string }
}

export const getSettingsMeta = async () => {
  const res = await apiClient.get('/settings/meta')
  return res.data as { dataDir: string; hasEncryptionKey: boolean; version: string; staging: string }
}

export const pauseScheduler = async () => {
  const res = await apiClient.post('/scheduler/pause')
  return res.data
}

export const resumeScheduler = async () => {
  const res = await apiClient.post('/scheduler/resume')
  return res.data
}

// ── Rclone remote management ──────────────────────────────────────────
export const getRcloneProviders = async () => {
  const res = await apiClient.get('/rclone/providers')
  return res.data as Array<{
    id: string; name: string; description: string
    authType: 'oauth' | 'key' | 'none'; icon: string
    fields: Array<{ name: string; label: string; type: string; required: boolean; placeholder?: string; description?: string }>
  }>
}

export const getRcloneRemotes = async () => {
  const res = await apiClient.get('/rclone/remotes')
  return res.data as Array<{ name: string; type: string; configured: boolean }>
}

export const createRcloneRemote = async (name: string, providerType: string, params: Record<string, string>) => {
  const res = await apiClient.post('/rclone/remotes', { name, providerType, params })
  return res.data
}

export const deleteRcloneRemote = async (name: string) => {
  await apiClient.delete(`/rclone/remotes/${encodeURIComponent(name)}`)
}

export const testRcloneRemote = async (name: string) => {
  const res = await apiClient.post(`/rclone/remotes/${encodeURIComponent(name)}/test`)
  return res.data as { ok: boolean; error?: string }
}

export const startRcloneOAuth = async (sessionId: string, providerType: string) => {
  const res = await apiClient.post('/rclone/oauth/start', { sessionId, providerType })
  return res.data as { url: string }
}

export const pollRcloneOAuthToken = async (sessionId: string) => {
  const res = await apiClient.get(`/rclone/oauth/token/${sessionId}`)
  return res.data as { token: string | null }
}

export const finishRcloneOAuth = async (sessionId: string, remoteName: string, providerType: string, token: string) => {
  const res = await apiClient.post('/rclone/oauth/finish', { sessionId, remoteName, providerType, token })
  return res.data
}

export const cancelRcloneOAuth = async (sessionId: string) => {
  await apiClient.post('/rclone/oauth/cancel', { sessionId })
}

export const protectStack = async (project: string) => {
  const res = await apiClient.post(`/docker/stacks/${encodeURIComponent(project)}/protect`)
  return res.data
}

export const getContainers = async () => {
  const res = await apiClient.get('/docker/containers')
  return res.data
}

export const getVolumes = async () => {
  const res = await apiClient.get('/docker/volumes')
  return res.data
}

export const getConnectors = async (): Promise<ConnectorDefinition[]> => {
  const res = await apiClient.get('/connectors/definitions')
  return res.data
}

export const getConnectorInstances = async (): Promise<ConnectorInstance[]> => {
  const res = await apiClient.get('/connectors')
  return res.data
}

export const saveConnectorInstance = async (connector: Partial<ConnectorInstance>) => {
  const res = await apiClient.post('/connectors', connector)
  return res.data
}

export const deleteConnectorInstance = async (id: string) => {
  const res = await apiClient.delete(`/connectors/${id}`)
  return res.data
}

export const getTelemetry = async () => {
  const res = await apiClient.get('/system/telemetry')
  return res.data
}

export const getSetting = async (key: string): Promise<string | null> => {
  const res = await apiClient.get(`/settings/${key}`)
  return res.data.value
}

export const saveSetting = async (key: string, value: string) => {
  const res = await apiClient.post(`/settings/${key}`, { value })
  return res.data
}

export const testConnector = async (type: string, config: any) => {
  const res = await apiClient.post('/connectors/test', { type, config })
  return res.data
}

export const discoverConnector = async (type: string, config: any) => {
  const res = await apiClient.post('/connectors/discover', { type, config })
  return res.data
}
