import { Request, Response, NextFunction, RequestHandler } from 'express'
import { LicenseService, LicenseFeature } from '../services/LicenseService'

/**
 * Express middleware factory that blocks a route unless the current license
 * grants the named feature. 402 Payment Required matches RFC 9110's
 * "reserved for future use related to digital payment" intent and is what
 * Stripe / Lemon Squeezy clients tend to expect for paywalled endpoints.
 */
export function requireFeature(license: LicenseService, feature: LicenseFeature): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await license.getStatus()
      if (!status.features.includes(feature)) {
        res.status(402).json({
          error: 'license_required',
          message: `Feature "${feature}" requires a paid license tier.`,
          currentTier: status.tier,
          upgrade: {
            personalPro: 'https://gozippy.com/drk/personal-pro',
            commercialPro: 'https://gozippy.com/drk/commercial-pro',
          },
        })
        return
      }
      next()
    } catch (err) {
      // If license resolution itself crashes, fail closed.
      res.status(500).json({ error: 'license_check_failed', message: (err as Error).message })
    }
  }
}
