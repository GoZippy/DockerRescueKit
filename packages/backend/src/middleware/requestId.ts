import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'

// Augment Express Request so callers can use `req.id` with type safety.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string
    }
  }
}

// Allow uuids and other id-shaped values clients may already correlate on,
// but reject anything obviously bogus to avoid log injection or unbounded
// header growth.
const VALID_REQUEST_ID = /^[a-zA-Z0-9-]{1,64}$/

/**
 * Stamps every request with a stable correlation id. Reuses the client's
 * `X-Request-Id` header when it looks safe, otherwise mints a fresh uuid.
 * Mirrors the id back on the response so log lines on either side of the
 * wire can be joined.
 */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id']
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming
    const id = candidate && VALID_REQUEST_ID.test(candidate) ? candidate : uuidv4()
    req.id = id
    res.setHeader('X-Request-Id', id)
    next()
  }
}
