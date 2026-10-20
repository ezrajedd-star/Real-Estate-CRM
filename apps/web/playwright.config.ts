import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { E2E, serviceEnv } from './e2e/support/env';

/**
 * End-to-end smoke test of the real stack: test OIDC provider → API (built) → worker →
 * web (built). Requires Postgres (migrated) and Redis to be running, plus
 * `pnpm --filter @crm/api build && pnpm --filter @crm/web build`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/support/global-setup.ts',
  use: {
    baseURL: E2E.web,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    // Use a preinstalled Chromium when present (sandboxed dev boxes); CI installs its own.
    launchOptions: chromiumPath() ? { executablePath: chromiumPath() } : {},
  },
  webServer: [
    {
      command: 'node ../../tools/test-idp/server.mjs',
      url: `${E2E.idp}/.well-known/openid-configuration`,
      env: serviceEnv,
      reuseExistingServer: false,
    },
    {
      command: 'npx tsx e2e/support/services.ts',
      port: E2E.s3Port,
      env: serviceEnv,
      reuseExistingServer: false,
    },
    {
      command: 'node ../api/dist/main.js',
      url: `${E2E.api}/api/v1/health/ready`,
      env: serviceEnv,
      reuseExistingServer: false,
    },
    {
      command: 'npx next start -p 3000',
      url: `${E2E.web}/login`,
      env: serviceEnv,
      reuseExistingServer: false,
    },
  ],
});

function chromiumPath(): string | undefined {
  const p = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  return p && existsSync(p) ? p : undefined;
}
