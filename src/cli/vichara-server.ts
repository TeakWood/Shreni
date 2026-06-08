import { startVicharaServer, DEFAULT_PORT } from '../vichara/server';
import { writeVicharaPid } from '../vichara/pid';
import { ensureToken } from '../vichara/token';

const port = process.env['VICHARA_PORT'] ? parseInt(process.env['VICHARA_PORT'], 10) : DEFAULT_PORT;

writeVicharaPid(process.pid);
ensureToken();

startVicharaServer(port)
  .then(() => {
    console.log(`[vichara] listening on http://127.0.0.1:${port}`);
  })
  .catch((err: Error) => {
    console.error('[vichara] failed to start:', err.message);
    process.exit(1);
  });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));