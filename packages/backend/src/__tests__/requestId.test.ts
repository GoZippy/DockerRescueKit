import express from 'express'
import http from 'http'
import { AddressInfo } from 'net'
import { requestId } from '../middleware/requestId'

// UUID v4 shape — accepted by both the middleware (as a fresh id) and the
// "is the response id a uuid?" assertions below.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface Captured {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function startApp(): Promise<{ url: string; close: () => Promise<void>; capturedId: () => string | undefined }> {
  return new Promise((resolve) => {
    const app = express()
    let lastReqId: string | undefined
    app.use(requestId())
    app.get('/echo', (req, res) => {
      // pino-http globally widens `req.id` to ReqId (string|number|object); our
      // middleware always sets a string, so the cast here is safe.
      lastReqId = req.id as string
      res.json({ id: req.id })
    })
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        capturedId: () => lastReqId
      })
    })
  })
}

function get(url: string, headers: Record<string, string> = {}): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.on('error', reject)
  })
}

describe('requestId middleware', () => {
  let app: Awaited<ReturnType<typeof startApp>>

  beforeEach(async () => { app = await startApp() })
  afterEach(async () => { await app.close() })

  it('sets req.id to a uuid v4 when no header is provided', async () => {
    const res = await get(`${app.url}/echo`)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toMatch(UUID_V4)
    expect(app.capturedId()).toBe(body.id)
  })

  it('reuses a well-formed incoming X-Request-Id', async () => {
    const incoming = 'abc-123-xyz-correlation'
    const res = await get(`${app.url}/echo`, { 'X-Request-Id': incoming })
    const body = JSON.parse(res.body)
    expect(body.id).toBe(incoming)
    expect(res.headers['x-request-id']).toBe(incoming)
  })

  it('replaces an over-long incoming X-Request-Id with a fresh uuid', async () => {
    const tooLong = 'a'.repeat(65)
    const res = await get(`${app.url}/echo`, { 'X-Request-Id': tooLong })
    const body = JSON.parse(res.body)
    expect(body.id).not.toBe(tooLong)
    expect(body.id).toMatch(UUID_V4)
  })

  it('replaces an X-Request-Id with disallowed characters with a fresh uuid', async () => {
    const bogus = 'hello world!@#'
    const res = await get(`${app.url}/echo`, { 'X-Request-Id': bogus })
    const body = JSON.parse(res.body)
    expect(body.id).not.toBe(bogus)
    expect(body.id).toMatch(UUID_V4)
  })

  it('mirrors the request id back on the response as X-Request-Id', async () => {
    const res = await get(`${app.url}/echo`)
    const body = JSON.parse(res.body)
    expect(res.headers['x-request-id']).toBe(body.id)
  })
})
