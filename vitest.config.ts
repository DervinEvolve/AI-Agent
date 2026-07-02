import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true, // agents write jest-style tests (bare describe/it/expect)
    include: ['**/*.test.ts', '**/*.test.js'],
    exclude: ['node_modules/**'],
  },
})
