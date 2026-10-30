import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    globalSetup: ['test/helpers/globalSetup.js'],
    // Each file gets its own database; files run one at a time to keep the
    // load on the shared test cluster predictable.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
