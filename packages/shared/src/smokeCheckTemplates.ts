import type { SmokeCheck } from './types'

/**
 * Pre-made smoke-check sets for the 6 stacks documented in
 * docs/STACK_RECIPES.md. Used by the rehearsal wizard (R-2) so users
 * don't have to author probes from scratch for popular apps.
 *
 * Naming convention: keys match the `name:` field in the stack recipe
 * doc so future tooling can cross-reference.
 */
export const SMOKE_CHECK_TEMPLATES: Record<string, SmokeCheck[]> = {
  homeassistant: [
    {
      kind: 'http',
      container: 'homeassistant',
      port: 8123,
      path: '/api/',
      expectStatus: 401, // unauth probe — proves the API listens
      timeoutMs: 15_000,
    },
    {
      kind: 'file_exists',
      container: 'homeassistant',
      path: '/config/home-assistant_v2.db',
      minBytes: 1024,
    },
  ],

  plex: [
    {
      kind: 'http',
      container: 'plex',
      port: 32400,
      path: '/identity',
      expectStatus: 200,
      timeoutMs: 15_000,
    },
    {
      kind: 'file_exists',
      container: 'plex',
      path: '/config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db',
      minBytes: 1024,
    },
  ],

  immich: [
    {
      kind: 'http',
      container: 'immich-server',
      port: 3001,
      path: '/api/server-info/ping',
      expectStatus: 200,
      bodyContains: 'pong',
      timeoutMs: 15_000,
    },
    {
      kind: 'sql_select_1',
      container: 'immich-postgres',
      driver: 'postgres',
      user: 'postgres',
      db: 'immich',
      passwordEnv: 'POSTGRES_PASSWORD',
      timeoutMs: 15_000,
    },
  ],

  nextcloud: [
    {
      kind: 'http',
      container: 'nextcloud',
      port: 80,
      path: '/status.php',
      expectStatus: 200,
      bodyContains: '"installed":true',
      timeoutMs: 15_000,
    },
    {
      kind: 'exec',
      container: 'nextcloud',
      command: ['php', 'occ', 'status'],
      expectExitCode: 0,
      stdoutContains: 'installed: true',
      timeoutMs: 30_000,
    },
  ],

  vaultwarden: [
    {
      kind: 'http',
      container: 'vaultwarden',
      port: 80,
      path: '/alive',
      expectStatus: 200,
      timeoutMs: 10_000,
    },
    {
      kind: 'file_exists',
      container: 'vaultwarden',
      path: '/data/db.sqlite3',
      minBytes: 1024,
    },
  ],

  n8n: [
    {
      kind: 'http',
      container: 'n8n',
      port: 5678,
      path: '/healthz',
      expectStatus: 200,
      timeoutMs: 10_000,
    },
    {
      kind: 'file_exists',
      container: 'n8n',
      path: '/home/node/.n8n/database.sqlite',
      minBytes: 1024,
    },
  ],
}
