import { defineConfig, devices } from '@playwright/test';

// E2E smoke: iba chromium, dev server sa spustí automaticky (ARCHITECTURE §16).
const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  reporter: 'list',
  // Sériovo: WebGL beží v headless Chromiu softvérovo (SwiftShader) a paralelné stránky si berú CPU —
  // test rýchlosti hodín (f1-roads) meria reálny čas a pri súbehu zlyhával.
  workers: 1,
  use: {
    baseURL: BASE_URL,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Server si Playwright spúšťa a ukončuje sám. Cudzí server na porte 5173 (`pnpm dev` z iného terminálu alebo worktree)
    // môže servírovať iný kód a pri 15-minútovom behu aj zaniknúť — všetky ďalšie testy by padli na ERR_CONNECTION_REFUSED
    // bez stopy v reporte. Obsadený port preto skončí hneď jasnou chybou; rýchlu slučku s vlastným serverom zapne PW_REUSE_SERVER=1.
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    // Výstup Vite (`page reload`, pád procesu) sa tak objaví v reporte a pri páde servera je vidieť prečo.
    stdout: 'pipe',
    timeout: 60_000,
  },
});
