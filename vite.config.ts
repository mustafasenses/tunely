import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { serviceWorker } from './scripts/vite-plugin-sw.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Short commit id shown in About: CI's GITHUB_SHA, else the local checkout, else "dev". */
function buildId(): string {
  const sha = process.env.GITHUB_SHA?.trim();
  if (sha) return sha.slice(0, 7);
  try {
    const out = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return /^[0-9a-f]{4,40}$/.test(out) ? out : 'dev';
  } catch {
    return 'dev';
  }
}

// Deployed to https://<user>.github.io/tunely/
export default defineConfig({
  base: '/tunely/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(buildId()),
  },
  plugins: [serviceWorker()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // DSP tests simulate many seconds of audio; shared CI runners are ~3x slower than a laptop.
    testTimeout: 60_000,
  },
});
