import Fastify from 'fastify';
import { registerPhalakaApi } from './api.js';
import { PhalakaChangeStream, registerPhalakaStream } from './stream.js';
import { INDEX_HTML } from './ui.js';

export const DEFAULT_PORT = 7348;
// Loopback only: the dashboard exposes task content across all Kshetras and has
// no per-request need for LAN access.
export const HOST = '127.0.0.1';

export async function createPhalakaServer(port = DEFAULT_PORT) {
  const fastify = Fastify({ logger: false });

  // The HTML shell carries no data; the page reads the token from its URL and
  // attaches it to API calls. Served unauthenticated.
  fastify.get('/', (_req, reply) => {
    return reply.type('text/html').send(INDEX_HTML);
  });

  registerPhalakaApi(fastify);

  // Live change stream (SSE). One engine per server; it starts its watch/poll
  // timers on the first connected client and stops them when the last leaves, so
  // an idle dashboard costs nothing. Torn down with the server.
  const stream = new PhalakaChangeStream();
  registerPhalakaStream(fastify, stream);
  fastify.addHook('onClose', async () => stream.close());

  return { fastify, port, stream };
}

export async function startPhalakaServer(port = DEFAULT_PORT): Promise<void> {
  const { fastify } = await createPhalakaServer(port);
  await fastify.listen({ port, host: HOST });
}