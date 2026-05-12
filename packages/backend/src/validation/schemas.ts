import { z } from 'zod'

// ---- Policies ---------------------------------------------------------------

export const CreatePolicySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  targets: z.array(
    z.object({
      type: z.string(),
      selector: z.string()
    })
  ),
  schedule: z.string(),
  backupType: z.enum(['full', 'incremental', 'differential']),
  retention: z.object({}).passthrough(),
  storage: z.object({
    id: z.string(),
    type: z.string()
  }).passthrough(),
  notifications: z.array(z.any()).optional()
})

export const UpdatePolicySchema = CreatePolicySchema.partial()

// ---- Backups ----------------------------------------------------------------

export const RestoreRequestSchema = z.object({
  dryRun: z.boolean().optional(),
  targetOverrides: z.record(z.any()).optional()
})

// ---- Connectors -------------------------------------------------------------

export const ConnectorTestSchema = z.object({
  type: z.string().min(1),
  config: z.record(z.any())
})

export const ConnectorDiscoverSchema = z.object({
  type: z.string().min(1),
  config: z.record(z.any())
})

export const SaveConnectorSchema = z.object({
  id: z.string().optional(),
  type: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.any())
})

// ---- Docker stacks ----------------------------------------------------------

export const ProtectStackSchema = z.object({}).passthrough()

// ---- Rclone -----------------------------------------------------------------

export const RcloneCreateRemoteSchema = z.object({
  name: z.string().min(1),
  providerType: z.string().min(1),
  params: z.record(z.any()).optional()
})

export const RcloneOAuthStartSchema = z.object({
  sessionId: z.string().min(1),
  providerType: z.string().min(1)
})

export const RcloneOAuthFinishSchema = z.object({
  sessionId: z.string().min(1),
  remoteName: z.string().min(1),
  providerType: z.string().min(1),
  token: z.string().min(1)
})

// ---- Settings ---------------------------------------------------------------

export const SaveSettingSchema = z.object({
  value: z.string()
})

// ---- Route params -----------------------------------------------------------

// Matches uuid-shaped ids and the few legacy id formats already in the db
// (slugs, hex digests). Keeps the route from passing untrusted blobs straight
// into sql/log statements.
export const idParamSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
})

// Compose project names may include dots (e.g. `acme.web`) and underscores,
// so the stack route needs a slightly looser ruleset than `id`.
export const projectParamSchema = z.object({
  project: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)
})

// `:name` covers rclone remote names — same shape as ids for now.
export const nameParamSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
})

// `:sessionId` for the rclone OAuth poll endpoint.
export const sessionIdParamSchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
})

// `:key` for the settings k/v endpoint — keys are well-known short slugs.
export const settingKeyParamSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/)
})

// ---- Query strings ----------------------------------------------------------

// Generic short-string query params: coerce to string, cap length so a giant
// querystring can't pin the event loop downstream.
const shortQueryString = z.string().max(1024)

export const fileQuerySchema = z.object({
  name: shortQueryString.optional(),
  path: shortQueryString.optional(),
  apiKey: shortQueryString.optional(),
  backup: shortQueryString.optional()
}).passthrough()
