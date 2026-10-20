import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one database; run files serially.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
