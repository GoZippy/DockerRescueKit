import pino, { LoggerOptions } from 'pino'
import pinoHttp from 'pino-http'

/**
 * Structured logger built on pino. Pretty-prints in non-production for human
 * developers; emits JSON in production so log aggregators can parse it.
 *
 * Level is taken from `LOG_LEVEL` (defaulting to `info`). Use `debug` or
 * `trace` when chasing a bug, `warn`/`error` to silence noisy environments.
 */
const isProduction = process.env.NODE_ENV === 'production'

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  // Redact sensitive fields anywhere in the log graph. The paths cover both
  // the request logger (`req.headers["x-api-key"]`, `req.query.apiKey`) and
  // any service-level call that happens to attach an `apiKey` field.
  redact: {
    paths: [
      'req.headers["x-api-key"]',
      'req.headers["X-Api-Key"]',
      'req.query.apiKey',
      'apiKey',
      '*.apiKey'
    ],
    censor: '[REDACTED]'
  }
}

const transport = !isProduction
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname'
      }
    }
  : undefined

export const logger = pino({
  ...baseOptions,
  ...(transport ? { transport } : {})
})

/**
 * pino-http middleware. Tags every log entry with the requestId minted by the
 * earlier `requestId()` middleware so log lines can be joined across services.
 *
 * `/healthz` and `/metrics` are excluded from access logging — they are hit
 * every few seconds by probes and would otherwise drown out real traffic.
 */
export const requestLogger = pinoHttp({
  logger,
  // Reuse the correlation id set by middleware/requestId.ts. pino-http calls
  // this once per request before issuing the log line.
  genReqId: (req) => (req as any).id,
  customProps: (req) => ({
    requestId: (req as any).id
  }),
  autoLogging: {
    ignore: (req) => {
      const url = req.url || ''
      return url === '/healthz' || url.startsWith('/metrics')
    }
  },
  // Quieter default serializers — pino-http's default also logs response body
  // size, which is fine, but the headers blob is noisy.
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      remoteAddress: req.remoteAddress
    }),
    res: (res) => ({ statusCode: res.statusCode })
  }
})
