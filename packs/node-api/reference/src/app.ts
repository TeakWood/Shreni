import Fastify, { type FastifyInstance } from 'fastify';
import { itemRoutes } from './routes/items.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ ok: true }));
  itemRoutes(app);
  return app;
}
