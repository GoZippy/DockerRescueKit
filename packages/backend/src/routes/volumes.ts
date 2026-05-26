import type { Application, Request, Response, NextFunction } from 'express'
import type { Database } from '../db/Database'
import type { DockerService } from '../services/DockerService'
import { BadRequestError } from '../errors/HttpError'
import type { VolumesManifestResponse, UnmanagedVolumesResponse } from '@docker-rescue-kit/shared'

/**
 * Volume Manifest REST surface — Safe Cleanup Wizard backend.
 *
 * Provides visibility into which volumes are backed up via restore-rehearsals,
 * and which volumes on the system have no backups (safe for cleanup).
 *
 * Mount with `mountVolumesRoutes(app, { db, docker })` from the main
 * BackupService constructor.
 *
 * The endpoints registered:
 *
 *   GET /api/volumes/manifest       — list backed-up volumes
 *   GET /api/volumes/unmanaged      — list volumes without backups
 */

export interface VolumesRouteDeps {
  db: Database
  docker: DockerService
}

export function mountVolumesRoutes(app: Application, deps: VolumesRouteDeps): void {
  const { db, docker } = deps

  // -------------------------------------------------------------------------
  // GET /api/volumes/manifest
  // -------------------------------------------------------------------------
  // Returns all backed-up volumes from the manifest.
  // Query params:
  //   ?policyId=<id>    — filter by policy
  //   ?since=<ISO8601>  — filter by timestamp
  //   ?limit=<n>        — limit result count
  app.get('/api/volumes/manifest', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policyId = typeof req.query.policyId === 'string' ? req.query.policyId : undefined
      const since = typeof req.query.since === 'string' ? req.query.since : undefined
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined

      if (isNaN(limit || 0)) {
        throw new BadRequestError('Invalid limit parameter')
      }

      const volumes = await db.getVolumesManifest({
        policyId,
        since,
        limit
      })

      const response: VolumesManifestResponse = {
        volumes,
        total: volumes.length,
        policyId
      }

      res.json(response)
    } catch (err) {
      next(err)
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/volumes/unmanaged
  // -------------------------------------------------------------------------
  // Returns volumes present on the system with NO entry in the manifest.
  // Used by Safe Cleanup Wizard to show "orphaned" volumes safe for cleanup.
  // Query params:
  //   ?policyId=<id>    — filter to volumes not backed up by this policy
  app.get('/api/volumes/unmanaged', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policyId = typeof req.query.policyId === 'string' ? req.query.policyId : undefined

      // Get all volumes on system
      const allVolumes = await docker.listVolumes()
      const systemVolumeNames = new Set(allVolumes.map(v => v.Name))

      // Get managed volumes (those in manifest)
      let managedVolumes: string[] = []
      if (policyId) {
        // Get volumes backed up by this specific policy
        const manifest = await db.getVolumesManifest({ policyId })
        managedVolumes = manifest.map(m => m.volumeName)
      } else {
        // Get all managed volumes
        managedVolumes = await db.getManagedVolumes()
      }
      const managedSet = new Set(managedVolumes)

      // Unmanaged = system volumes not in manifest
      const unmanagedVolumes = Array.from(systemVolumeNames)
        .filter(name => !managedSet.has(name))
        .sort()

      const response: UnmanagedVolumesResponse = {
        unmanagedVolumes,
        total: unmanagedVolumes.length
      }

      res.json(response)
    } catch (err) {
      next(err)
    }
  })
}
