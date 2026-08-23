import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    coverage: {
      // Coverage is reported for the domain specifically. Adapters are thin
      // wrappers over browser APIs and are covered by their fakes plus the E2E
      // smoke test, so a blended number would flatter the parts that matter.
      include: ['src/domain/**'],
      reporter: ['text', 'json-summary'],
    },
  },
})
