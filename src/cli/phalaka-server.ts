import { startPhalakaServer, DEFAULT_PORT } from '../phalaka/server';
import { writePhalakaPid } from '../phalaka/pid';
import { ensureToken } from '../phalaka/token';

const port = process.env['PHALAKA_PORT'] ? parseInt(process.env['PHALAKA_PORT'], 10) : DEFAULT_PORT;

writePhalakaPid(process.pid);
// Ensures the local dashboard token (~/.shreni/shreni.token) exists — shared secret.
ensureToken();

startPhalakaServer(port)
  .then(() => {
    console.log(`[phalaka] listening on http://127.0.0.1:${port}`);
  })
  .catch((err: Error) => {
    console.error('[phalaka] failed to start:', err.message);
    process.exit(1);
  });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));