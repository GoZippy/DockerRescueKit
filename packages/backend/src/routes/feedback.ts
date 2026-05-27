import { Express, Request, Response, NextFunction } from 'express'
import { BadRequestError } from '../errors'
import {
  FeedbackService,
  FEEDBACK_TYPES,
  type FeedbackType,
  type FeedbackSubmission,
} from '../services/FeedbackService'

/**
 * v1.2.2 in-product feedback routes.
 *
 * POST /api/feedback        — submit a report (returns 202 + per-sink outcome)
 * GET  /api/feedback/config — describe which sinks are configured (booleans)
 */
export function mountFeedbackRoutes(
  app: Express,
  { feedback }: { feedback: FeedbackService },
) {
  const asyncHandler = (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
  ) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

  // Validation matches the constraints in the spec:
  //   - type ∈ FEEDBACK_TYPES
  //   - message ≤ 16000 chars
  //   - screenshotPngBase64 ≤ 8MB if present
  // Inline rather than via the central schemas file so feedback validation
  // stays adjacent to the only route that uses it.
  const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024
  const MESSAGE_MAX = 16_000

  app.post('/api/feedback', asyncHandler(async (req, res) => {
    const body = req.body || {}
    const type = body.type
    if (typeof type !== 'string' || !(FEEDBACK_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestError(`type must be one of: ${FEEDBACK_TYPES.join(', ')}`)
    }
    const message = body.message
    if (typeof message !== 'string' || message.length === 0) {
      throw new BadRequestError('message is required (non-empty string)')
    }
    if (message.length > MESSAGE_MAX) {
      throw new BadRequestError(`message exceeds ${MESSAGE_MAX} characters`)
    }
    const screenshot = body.screenshotPngBase64
    if (screenshot !== undefined) {
      if (typeof screenshot !== 'string') {
        throw new BadRequestError('screenshotPngBase64 must be a string')
      }
      if (screenshot.length > SCREENSHOT_MAX_BYTES) {
        throw new BadRequestError('screenshotPngBase64 exceeds 8MB')
      }
    }
    const context = body.context
    if (context !== undefined && (typeof context !== 'object' || context === null || Array.isArray(context))) {
      throw new BadRequestError('context must be an object')
    }

    const submission: FeedbackSubmission = {
      type: type as FeedbackType,
      message,
      screenshotPngBase64: screenshot,
      context: context || undefined,
    }
    const result = await feedback.submit(submission)
    // 202 — accepted; some sinks may have completed sync, others may be
    // skipped/failed (still surface the outcome map). The UI shows it as
    // "report saved, here's where it went."
    res.status(202).json(result)
  }))

  app.get('/api/feedback/config', asyncHandler(async (_req, res) => {
    res.json(await feedback.describeConfiguration())
  }))
}
