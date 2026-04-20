// Schema is now auto-applied by connection.js on open.
// This CLI entry point remains for explicit migration runs and backward-compat.
import { db } from './connection.js';

export function migrate() {
  // no-op: schema already applied when connection.js loaded
  return { ok: true };
}

const invokedAsCli = process.argv[1]?.replace(/\\/g, '/').endsWith('/db/migrate.js');
if (invokedAsCli) {
  migrate();
  console.log('[migrate] schema applied to', process.env.DB_PATH || 'data/app.db');
}
