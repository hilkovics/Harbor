import { defineConfig, devices } from '@playwright/test';

// E2E smoke: iba chromium, dev server sa spustí automaticky (ARCHITECTURE §16).
const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
