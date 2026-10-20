import type { Logger } from '@crm/platform';
import { createApp } from './bootstrap.js';
import { LOGGER } from './common/tokens.js';
import { ENV, type Env } from './config/env.js';

const app = await createApp();
const env = app.get<Env>(ENV);
await app.listen({ port: env.PORT, host: '0.0.0.0' });
app.get<Logger>(LOGGER).info({ port: env.PORT }, 'api listening');
