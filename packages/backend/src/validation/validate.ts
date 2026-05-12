import { ZodSchema } from 'zod'
import { Request, Response, NextFunction } from 'express'

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      return res.status(400).json({ error: 'Validation error', details: result.error.flatten() })
    }
    req.body = result.data  // use parsed/coerced data
    next()
  }
}

/**
 * Validates `req.params` against a schema. Lets us reject obviously malformed
 * route ids (overlong strings, special chars) before they reach the data
 * layer, without sprinkling regex checks across every handler.
 */
export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params)
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid route parameter', details: result.error.flatten() })
    }
    next()
  }
}

/**
 * Validates `req.query`. Mirrors `validateParams` but for querystring values.
 * Schemas should generally be `.passthrough()` so unknown keys aren't dropped.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid query parameter', details: result.error.flatten() })
    }
    next()
  }
}
