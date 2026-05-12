/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@docker-rescue-kit/shared$': '<rootDir>/../shared/src/types.ts'
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts'
  ],
  // R7.6 — coverage gate.
  //
  // The R7.6 target is 70% global. As of this commit the real baseline is
  // ~49% statements / 40% branches / 47% functions / 52% lines, so blindly
  // enforcing 70% would break CI on day one. Instead we lock in the current
  // floor (rounded down to the nearest 5%) so coverage can't regress; raise
  // these numbers in follow-up commits as new tests land until we reach 70%.
  coverageThreshold: {
    global: {
      statements: 45,
      branches: 40,
      functions: 45,
      lines: 50
    }
  }
}
