/**
 * Regression tests for NotificationDispatcher constructor TDZ bug.
 *
 * In v1.2.0/v1.2.1 the constructor parameter `logger` shadowed the imported
 * `logger` name, producing a Temporal Dead Zone crash on startup:
 *   ReferenceError: Cannot access 'logger' before initialization
 *
 * The fix (renamed import to defaultLogger) shipped in v1.2.2.  These tests
 * verify the constructor no longer crashes with or without an explicit logger.
 */

import { NotificationDispatcher } from '../../services/NotificationDispatcher'

// ---------------------------------------------------------------------------
// Helpers — minimal mocks, we only care that the constructor doesn't throw
// ---------------------------------------------------------------------------

const fakeDatabase = {} as any
const fakeDockerService = {} as any
const fakeNotificationService = {} as any

const fakeLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  silent: jest.fn(),
  level: 'info',
  child: jest.fn(),
} as any

// ---------------------------------------------------------------------------

describe('NotificationDispatcher — constructor (TDZ regression)', () => {
  it('instantiates without error when no explicit logger is passed', () => {
    expect(
      () => new NotificationDispatcher(
        fakeDatabase,
        fakeDockerService,
        fakeNotificationService,
      ),
    ).not.toThrow()
  })

  it('accepts an explicit logger as the 4th argument without error', () => {
    expect(
      () => new NotificationDispatcher(
        fakeDatabase,
        fakeDockerService,
        fakeNotificationService,
        fakeLogger,
      ),
    ).not.toThrow()
  })

  it('defaults to the imported defaultLogger when no 4th arg is given', () => {
    const instance = new NotificationDispatcher(
      fakeDatabase,
      fakeDockerService,
      fakeNotificationService,
    )
    expect((instance as any).logger).toBeDefined()
    expect(typeof (instance as any).logger.info).toBe('function')
  })
})
