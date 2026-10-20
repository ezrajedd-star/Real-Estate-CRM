import { type Logger, createLogger } from '@crm/platform';
import { createApp } from './bootstrap.js';
import { LOGGER } from './common/tokens.js';
import { ENV, type Env } from './config/env.js';

try {
  const app = await createApp();
  const env = app.get<Env>(ENV);
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.get<Logger>(LOGGER).info({ port: env.PORT }, 'api listening');
} catch (err) {
  // Nest's own logger is disabled; report startup failures (e.g. invalid configuration —
  // variable names only, never values) through the redacting logger, then exit non-zero.
  createLogger({ name: 'api' }).fatal({ err }, 'api failed to start');
  process.exit(1);
}
