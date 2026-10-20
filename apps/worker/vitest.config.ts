import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    env: { LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64') },
  },
});
