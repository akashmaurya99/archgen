import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // jsdom is opted into per-file via @vitest-environment jsdom docblock.
  },
});
