import path from 'path'
import fs from 'fs-extra'

/**
 * Backend version, resolved once at module load by walking up from
 * `__dirname` until we find the backend's own `package.json`.
 *
 * Works in both dev (src/index.ts) and prod (dist/backend/src/index.js),
 * since the directory depth between the compiled file and the manifest
 * differs by one. We stop at the first package.json whose `name` matches
 * `@docker-rescue-kit/backend` to avoid picking up the workspace root or
 * a dependency's manifest along the way.
 *
 * Falls back to the literal string 'unknown' if the walk runs out without
 * finding a match — callers should treat that as "not in a normal install".
 */
export const APP_VERSION: string = (() => {
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (pkg?.name === '@docker-rescue-kit/backend' && typeof pkg.version === 'string') {
        return pkg.version
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
})()
