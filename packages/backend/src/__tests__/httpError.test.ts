import express, { Request, Response, NextFunction } from 'express'
import http from 'http'
import { AddressInfo } from 'net'
import {
  HttpError,
  NotFoundError,
  ConflictError,
  BadRequestError,
  ServiceUnavailableError,
  InternalError,
} from '../errors'

// ---------------------------------------------------------------------------
// Pure unit tests on the class hierarchy itself
// ---------------------------------------------------------------------------

describe('HttpError class hierarchy', () => {
  it('NotFoundError formats message and uses 404', () => {
    const err = new NotFoundError('Policy', 'abc')
    expect(err.statusCode).toBe(404)
    expect(err.message).toContain('Policy')
    expect(err.message).toContain('abc')
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toBeInstanceOf(Error)
  })

  it('NotFoundError without id still works', () => {
    const err = new NotFoundError('Backup')
    expect(err.statusCode).toBe(404)
    expect(err.message).toContain('Backup')
  })

  it('BadRequestError uses 400 and forwards code', () => {
    const err = new BadRequestError('bad input')
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('bad input')

    const withCode = new BadRequestError('bad input', 'INVALID_FIELD')
    expect(withCode.code).toBe('INVALID_FIELD')
  })

  it('ConflictError uses 409', () => {
    const err = new ConflictError('already exists')
    expect(err.statusCode).toBe(409)
    expect(err.message).toBe('already exists')
  })

  it('ServiceUnavailableError uses 503', () => {
    const err = new ServiceUnavailableError('docker offline')
    expect(err.statusCode).toBe(503)
  })

  it('InternalError uses 500', () => {
    const err = new InternalError('boom')
    expect(err.statusCode).toBe(500)
  })

  it('each subclass sets `name` to its class name', () => {
    expect(new NotFoundError('x').name).toBe('NotFoundError')
    expect(new ConflictError('x').name).toBe('ConflictError')
    expect(new BadRequestError('x').name).toBe('BadRequestError')
    expect(new ServiceUnavailableError('x').name).toBe('ServiceUnavailableError')
    expect(new InternalError('x').name).toBe('InternalError')
  })

  it('subclasses pass `instanceof HttpError` — protects switch-on-type logic', () => {
    expect(new NotFoundError('x') instanceof HttpError).toBe(true)
    expect(new ConflictError('x') instanceof HttpError).toBe(true)
    expect(new BadRequestError('x') instanceof HttpError).toBe(true)
    expect(new ServiceUnavailableError('x') instanceof HttpError).toBe(true)
    expect(new InternalError('x') instanceof HttpError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration: a tiny Express app wires the same error middleware shape used
// in `index.ts`, so we can confirm thrown HttpErrors flow to the right
// status code and body. Uses raw `http` to avoid pulling in supertest as a
// new devDependency (matches the pattern in requestId.test.ts).
// ---------------------------------------------------------------------------

interface Captured {
  status: number
  body: string
}

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = express()

    const asyncHandler = (
      fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
    ) => (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next)
    }

    app.get('/notfound', asyncHandler(async () => {
      throw new NotFoundError('Policy', 'p1')
    }))
    app.get('/badreq', asyncHandler(async () => {
      throw new BadRequestError('missing field', 'MISSING_FIELD')
    }))
    app.get('/conflict', asyncHandler(async () => {
      throw new ConflictError('already exists')
    }))
    app.get('/unavailable', asyncHandler(async () => {
      throw new ServiceUnavailableError('upstream offline')
    }))
    app.get('/boom', asyncHandler(async () => {
      throw new Error('plain error — should become 500')
    }))

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err instanceof HttpError ? err.statusCode : 500
      res.status(status).json({
        error: err.message || 'Internal Server Error',
        code: err.code,
      })
    })

    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

function get(url: string): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
  })
}

describe('HttpError + Express middleware integration', () => {
  let app: Awaited<ReturnType<typeof startApp>>

  beforeAll(async () => { app = await startApp() })
  afterAll(async () => { await app.close() })

  it('NotFoundError surfaces as 404 with descriptive message', async () => {
    const res = await get(`${app.url}/notfound`)
    expect(res.status).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('Policy')
    expect(body.error).toContain('p1')
    expect(body.code).toBe('NOT_FOUND')
  })

  it('BadRequestError surfaces as 400 with custom code', async () => {
    const res = await get(`${app.url}/badreq`)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).code).toBe('MISSING_FIELD')
  })

  it('ConflictError surfaces as 409', async () => {
    const res = await get(`${app.url}/conflict`)
    expect(res.status).toBe(409)
  })

  it('ServiceUnavailableError surfaces as 503', async () => {
    const res = await get(`${app.url}/unavailable`)
    expect(res.status).toBe(503)
  })

  it('plain Error still becomes a 500 (no leakage of unknown statuses)', async () => {
    const res = await get(`${app.url}/boom`)
    expect(res.status).toBe(500)
  })
})
