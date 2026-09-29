import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Aliasy musia zodpovedať `compilerOptions.paths` v tsconfig.json.
const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sim': fromRoot('./src/sim'),
      '@render': fromRoot('./src/render'),
      '@ui': fromRoot('./src/ui'),
      '@app': fromRoot('./src/app'),
      '@data': fromRoot('./data'),
    },
  },
  server: {
    watch: { ignored: ['**/.claude/**'] },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', '.claude/**', 'node_modules/**', 'dist/**'],
    passWithNoTests: true,
  },
});
