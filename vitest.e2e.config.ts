import { defineConfig } from 'vitest/config'

// End-to-end suites against a running local worker (`node scripts/verify/dev.mjs up`).
// Files run one at a time: some flip shared local state (KV kill switch).
export default defineConfig({
  test: {
    include: ['src/e2e/**/*.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
