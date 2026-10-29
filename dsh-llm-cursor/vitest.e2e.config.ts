import { defineConfig } from 'vitest/config'

// Real-API suite: key-gated (each test self-skips without $CURSOR_API_KEY),
// with generous timeouts for live Cursor SDK runs.
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
})
