import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from './document.js';

// `pnpm --filter @crm/api openapi` → docs/api/openapi.json (committed, reviewed in PRs).
const out = new URL('../../../../docs/api/openapi.json', import.meta.url);
writeFileSync(out, JSON.stringify(buildOpenApiDocument(), null, 2) + '\n');
process.stdout.write(`wrote ${out.pathname}\n`);
