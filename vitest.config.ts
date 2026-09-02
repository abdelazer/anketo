import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/setup/netlify-dev.ts'],
    // These talk to a real Netlify dev server and wait out real countdowns.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // One dev server, one Blobs store — never run files against it in parallel.
    fileParallelism: false,
  },
})
