import { fileURLToPath } from 'node:url';
import { migrate } from '../migrator.js';

const url = process.env.DATABASE_URL_MIGRATOR;
if (!url) {
  process.stderr.write('DATABASE_URL_MIGRATOR is not set\n');
  process.exit(1);
}

const dir = fileURLToPath(new URL('../../migrations', import.meta.url));
const result = await migrate(url, dir);
process.stdout.write(
  `Applied ${result.applied.length} migration(s)${result.applied.length ? `: ${result.applied.join(', ')}` : ''}; ` +
    `${result.skipped.length} already applied. Role permissions synced.\n`,
);
