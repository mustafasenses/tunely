import { defineConfig } from 'vitest/config';

// Deployed to https://<user>.github.io/tunely/
export default defineConfig({
  base: '/tunely/',
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
