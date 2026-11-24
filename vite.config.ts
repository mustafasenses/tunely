import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { serviceWorker } from './scripts/vite-plugin-sw.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Deployed to https://<user>.github.io/tunely/
export default defineConfig({
  base: '/tunely/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [serviceWorker()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
