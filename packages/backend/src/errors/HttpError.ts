/**
 * Typed HTTP error hierarchy.
 *
 * Routes throw a subclass and the central error middleware in `index.ts`
 * translates `instanceof HttpError` into the right status code + JSON body.
 * This replaces the older pattern of `try { ... } catch { res.status(500) }`
 * which would 500 even legitimate 4xx situations like "policy not found"
 * or "rclone remote already exists".
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'HttpError'
    // Preserve a clean prototype chain after transpilation to ES5/CommonJS,
    // so `instanceof` works through the subclass hierarchy.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class NotFoundError extends HttpError {
  constructor(resource: string, id?: string) {
    const msg = id !== undefined
      ? `${resource} '${id}' not found`
      : `${resource} not found`
    super(404, msg, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, code?: string) {
    super(400, message, code || 'BAD_REQUEST')
    this.name = 'BadRequestError'
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(reason: string) {
    super(503, reason, 'SERVICE_UNAVAILABLE')
    this.name = 'ServiceUnavailableError'
  }
}

export class InternalError extends HttpError {
  constructor(message: string) {
    super(500, message, 'INTERNAL_ERROR')
    this.name = 'InternalError'
  }
}
