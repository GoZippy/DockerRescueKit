import { BackupPolicy, Backup, ConnectorInstance, ConnectorDefinition, GuardEvent, GuardSettings } from '@docker-rescue-kit/shared'
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

export interface SettingsMetaDTO {
  dataDir: string
  hasEncryptionKey: boolean
  version: string
  staging: string
  /**
   * ISO timestamp of the most recent successful config export
   * (mtime of `latest-bootstrap.json`). Optional — older backends
   * that haven't been updated yet will simply omit this field, in
   * which case the UI should treat it as "never exported".
   */
  lastExportAt?: string
}

export const getSettingsMeta = async () => {
  return apiClient.get<SettingsMetaDTO>('/settings/meta')
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

// Health probe for the rclone bundled in the DRK backend. Powers the
// "rclone ready" badge and decides whether to show the install helper.
export const checkRclone = async () => {
  return apiClient.get<{ installed: boolean; version: string | null; configPath: string }>('/rclone/check')
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

// Returns the `rclone authorize` command the user runs on a machine that has
// a browser; the token it prints is pasted back via finishRcloneOAuth.
export const startRcloneOAuth = async (providerType: string) => {
  return apiClient.post<{ command: string }>('/rclone/oauth/start', { providerType })
}

export const finishRcloneOAuth = async (remoteName: string, providerType: string, token: string) => {
  return apiClient.post<any>('/rclone/oauth/finish', { remoteName, providerType, token })
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

// ── Cost Analysis (C-3) ───────────────────────────────────────────────────

export const getCostConfig = async () => {
  return apiClient.get<Array<{
    storageType: string
    label: string
    icon: string
    costPerGBMonth: number
    costPerGBDownload: number
    restoreSpeedMBps: number
    durability: string
    notes: string
  }>>('/settings/cost-config')
}

// ── License (v1.2.2) ──────────────────────────────────────────────────────

export interface LicenseStatusDTO {
  tier: 'free' | 'pro' | 'enterprise'
  seats: number
  features: string[]
  majorVersion?: string
  launchLockIn: boolean
  expiresAt?: string
  staleButValid: boolean
  licenseId?: string
  devMode: boolean
}

export const getLicenseStatus = async (): Promise<LicenseStatusDTO> => {
  return apiClient.get<LicenseStatusDTO>('/license')
}

// ── Version / update check (v1.2.2) ───────────────────────────────────────

export interface VersionCheckResult {
  current: string
  latest: string | null
  updateAvailable: boolean
  checkedAt: string
  hubError?: string
}

export const checkVersion = async (): Promise<VersionCheckResult> => {
  return apiClient.get<VersionCheckResult>('/version/check')
}

// ── Feedback (v1.2.2) ─────────────────────────────────────────────────────

export type FeedbackType =
  | 'bug' | 'suggestion' | 'wish' | 'integration_request' | 'question'

export interface FeedbackSubmission {
  type: FeedbackType
  message: string
  screenshotPngBase64?: string
  context?: {
    page?: string
    version?: string
    dataDir?: string
    userAgent?: string
  }
}

export type FeedbackSinkOutcome = 'sent' | 'failed' | 'skipped'

export interface FeedbackResult {
  id: string
  sinks: Record<string, FeedbackSinkOutcome>
}

export const submitFeedback = async (
  payload: FeedbackSubmission,
): Promise<FeedbackResult> => {
  return apiClient.post<FeedbackResult>('/feedback', payload)
}

export interface FeedbackConfigStatus {
  webhookConfigured: boolean
  emailConfigured: boolean
  githubConfigured: boolean
}

export const getFeedbackConfig = async (): Promise<FeedbackConfigStatus> => {
  return apiClient.get<FeedbackConfigStatus>('/feedback/config')
}

// ── Config export / import ────────────────────────────────────────────────

export interface ConfigExportBundle {
  version: string
  exportedAt: string
  data: {
    settings: Array<{ key: string; value: string }>
    policies: any[]
    storageVaults: any[]
    backupHistory: any[]
    auditLog: any[]
  }
}

export const exportConfig = async (): Promise<ConfigExportBundle> => {
  // Route through the shared apiClient so both transport modes work correctly:
  // - TCP mode: axios with x-api-key header injected automatically.
  // - Extension mode: ddClient.extension.vm.service (no API key needed;
  //   Docker Desktop guarantees the channel).
  // The backend returns JSON (Content-Disposition: attachment is advisory only).
  // SettingsPage constructs the browser download Blob from the returned object.
  return apiClient.get<ConfigExportBundle>('/config/export')
}

export const importConfig = async (bundle: ConfigExportBundle): Promise<{ ok: boolean; policiesImported: number }> => {
  return apiClient.post('/config/import', bundle)
}

// ── Config import — preview/apply (Sprint 3 wizard) ───────────────────────
// Two-step flow served by ImportService on the backend. The wizard UI in
// components/ImportWizard.tsx consumes these.
export type ImportSourceMode = 'json' | 'bind-mount-json' | 'legacy-sqlite-db'

export interface ImportPreview {
  source: ImportSourceMode
  schemaVersion?: string
  detectedAppVersion?: string
  counts: { policies: number; vaults: number; settings: number; audit: number }
  warnings: string[]
  confirmationToken: string
}

export interface ImportResult {
  applied: boolean
  counts: ImportPreview['counts']
  errors: string[]
}

export const importConfigPreview = async (
  req: { source: ImportSourceMode; payload?: any; path?: string },
): Promise<ImportPreview> => apiClient.post('/config/import?mode=preview', req)

export const importConfigApply = async (
  token: string,
): Promise<ImportResult> => apiClient.post('/config/import?mode=apply', { token })

// ── Prune Guard (PG-1.5 UI) ───────────────────────────────────────────────
// All endpoints are gated: if GET /api/guard/settings returns 404 the backend
// hasn't landed yet (PG-1.4 not yet deployed). All callers must handle the
// 404 gracefully and hide the guard UI surfaces rather than surfacing an error.

export const getGuardSettings = async (): Promise<GuardSettings> => {
  return apiClient.get<GuardSettings>('/guard/settings')
}

export const updateGuardSettings = async (
  patch: Partial<GuardSettings>,
): Promise<GuardSettings> => {
  return apiClient.put<GuardSettings>('/guard/settings', patch)
}

export const listGuardEvents = async (opts?: {
  limit?: number
  status?: string
  before?: string
}): Promise<GuardEvent[]> => {
  const params: Record<string, unknown> = {}
  if (opts?.limit  != null) params['limit']  = opts.limit
  if (opts?.status != null) params['status'] = opts.status
  if (opts?.before != null) params['before'] = opts.before
  return apiClient.get<GuardEvent[]>('/guard/events', params)
}

export const getGuardEvent = async (id: string): Promise<GuardEvent> => {
  return apiClient.get<GuardEvent>(`/guard/events/${id}`)
}

export const restoreGuardEvent = async (
  id: string,
  opts?: { volumes?: string[] },
): Promise<{ restored: string[] }> => {
  return apiClient.post<{ restored: string[] }>(`/guard/events/${id}/restore`, opts ?? {})
}

export const pinGuardEvent = async (id: string): Promise<void> => {
  await apiClient.post<unknown>(`/guard/events/${id}/pin`)
}

export const deleteGuardEvent = async (id: string): Promise<void> => {
  await apiClient.delete<unknown>(`/guard/events/${id}`)
}

/**
 * Returns an EventSource URL for GET /api/guard/stream (SSE).
 * Mirrors the rehearsal stream pattern at api.ts:getRehearsalStreamUrl.
 * In extension mode the ddClient channel handles auth; no apiKey query param.
 * In TCP mode ?apiKey= is appended so the server can authenticate the SSE
 * connection (EventSource does not support custom headers).
 */
export const getGuardStreamUrl = (): string => {
  if (import.meta.env.VITE_TRANSPORT === 'extension') {
    return `/api/guard/stream`
  }
  return `/api/guard/stream?apiKey=${encodeURIComponent(getApiKey())}`
}
