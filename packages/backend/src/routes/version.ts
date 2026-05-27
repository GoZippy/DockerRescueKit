import { Express, Request, Response, NextFunction } from 'express'
import axios from 'axios'
import { logger } from '../utils/logger'
import { APP_VERSION } from '../utils/appVersion'
import type { SettingsService } from '../services/SettingsService'

/**
 * v1.2.2 update-check route. Reads the currently-running backend version from
 * the same source as /api/settings/meta (the backend's own package.json,
 * walked at module load in utils/appVersion.ts) and compares it against the
 * highest semver tag on the Docker Hub repo.
 *
 * Failure modes are intentionally non-fatal — if Docker Hub is unreachable or
 * returns garbage we just return `{ latest: null, hubError }`. The UI treats
 * that as "couldn't check, try again later" rather than an error toast.
 */
export function mountVersionRoutes(
  app: Express,
  // SettingsService is passed in for parity with the other mount points and
  // for future use (e.g. user-pinned channels); not consumed today.
  _opts: { settings: SettingsService },
) {
  const asyncHandler = (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
  ) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

  app.get('/api/version/check', asyncHandler(async (_req, res) => {
    const current = APP_VERSION
    const checkedAt = new Date().toISOString()

    try {
      const hubResp = await axios.get<{
        results?: Array<{ name?: string; last_updated?: string }>
      }>(
        'https://hub.docker.com/v2/repositories/gozippy/dockerrescuekit/tags?page_size=10&ordering=last_updated',
        { timeout: 10_000 },
      )

      const semverRe = /^v?(\d+)\.(\d+)\.(\d+)$/
      let latest: string | null = null
      let latestParsed: [number, number, number] | null = null
      for (const tag of hubResp.data?.results || []) {
        const name = tag?.name
        if (typeof name !== 'string') continue
        const m = name.match(semverRe)
        if (!m) continue
        const parsed: [number, number, number] = [
          Number(m[1]),
          Number(m[2]),
          Number(m[3]),
        ]
        if (!latestParsed || compareSemver(parsed, latestParsed) > 0) {
          latestParsed = parsed
          latest = name
        }
      }

      const updateAvailable =
        latestParsed !== null &&
        current !== 'unknown' &&
        (() => {
          const cur = current.match(semverRe)
          if (!cur) return false
          const curParsed: [number, number, number] = [
            Number(cur[1]),
            Number(cur[2]),
            Number(cur[3]),
          ]
          return compareSemver(latestParsed!, curParsed) > 0
        })()

      res.json({
        current,
        latest,
        updateAvailable,
        checkedAt,
      })
    } catch (err: any) {
      const message = err?.message || String(err)
      // Don't throw — the spec is explicit that Hub failures must surface as
      // a soft hubError so the UI can render "couldn't check" gracefully.
      logger.warn({ err }, '[Version] Docker Hub tag fetch failed')
      res.json({
        current,
        latest: null,
        updateAvailable: false,
        checkedAt,
        hubError: message,
      })
    }
  }))
}

function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] - b[2]
}
