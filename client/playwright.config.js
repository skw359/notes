import { defineConfig } from '@playwright/test'

const APP_PORT = process.env.E2E_APP_PORT || '4610'
const CONTROL_PORT = process.env.E2E_CONTROL_PORT || '4611'

// Browser end-to-end tests against the real server on an isolated test
// database (TEST_DATABASE_URL), serving the built client (npm run build).
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.js',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/server.mjs',
    url: `http://127.0.0.1:${CONTROL_PORT}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, E2E_APP_PORT: APP_PORT, E2E_CONTROL_PORT: CONTROL_PORT },
  },
})
