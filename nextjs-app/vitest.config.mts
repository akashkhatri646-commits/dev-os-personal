import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // 'server-only' throws outside the Next.js server bundle; tests run in plain Node.
      'server-only': path.resolve(import.meta.dirname, 'tests/support/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/server/**', 'src/lib/**'] },
  },
})
