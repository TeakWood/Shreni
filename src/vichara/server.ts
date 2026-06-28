import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { loadRegistry } from '../kshetra/registry.js';
import { loadState } from '../kshetra/state.js';
import { readToken } from './token.js';
import { runVicharaTurn } from './agent.js';
import { buildVicharaSystemPrompt } from './prompt.js';
import { parseAtMention, resolveAtMentionKshetra } from '../sthapathi/at-mention.js';
import { INDEX_HTML, MANIFEST_JSON } from './pwa.js';
import type { KshetraConfig } from '../kshetra/config.js';

export const DEFAULT_PORT = 7347;
const STATUS_INTERVAL_MS = 30_000;

function buildStatusPayload(kshetras: KshetraConfig[]) {
  const state = loadState();
  return {
    type: 'status',
    kshetras: kshetras.map(k => {
      const ks = state.kshetras[k.id] ?? { paused: false };
      return { id: k.id, name: k.name, paused: ks.paused ?? false };
    }),
  };
}

const VICHARA_MODEL = 'claude-sonnet-4-6';

export async function createVicharaServer(port = DEFAULT_PORT) {
  // Auth is delegated to the `claude` CLI (subscription/OAuth), exactly like the
  // agent provider adapters — no ANTHROPIC_API_KEY is required.
  const fastify = Fastify({ logger: false });
  await fastify.register(fastifyWebsocket);

  fastify.get('/', (_req, reply) => {
    return reply.type('text/html').send(INDEX_HTML);
  });

  fastify.get('/manifest.json', (_req, reply) => {
    return reply.type('application/manifest+json').send(MANIFEST_JSON);
  });

  fastify.get(
    '/ws',
    { websocket: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (socket: any, request: any) => {
      const rawUrl: string = request.url ?? '';
      const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
      const params = new URLSearchParams(qs);
      const providedToken = params.get('token');
      const expectedToken = readToken();

      if (providedToken !== expectedToken) {
        socket.close(4401, 'Unauthorized');
        return;
      }

      const kshetras = loadRegistry();

      const safeSend = (data: object) => {
        try {
          socket.send(JSON.stringify(data));
        } catch {
          // socket closed
        }
      };

      safeSend(buildStatusPayload(kshetras));

      const statusInterval = setInterval(() => {
        safeSend(buildStatusPayload(loadRegistry()));
      }, STATUS_INTERVAL_MS);

      socket.on('close', () => clearInterval(statusInterval));

      socket.on('message', async (raw: Buffer | string) => {
        let msg: { type: string; text?: string };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type !== 'chat' || !msg.text) return;

        const text = msg.text;
        const mentioned = parseAtMention(text);
        const activeKshetra = mentioned
          ? resolveAtMentionKshetra(mentioned.kshetraId, kshetras)
          : (kshetras[0] ?? null);
        const chatText = mentioned ? mentioned.text : text;

        const systemPrompt = buildVicharaSystemPrompt({
          activeKshetra,
          allKshetras: kshetras,
          currentTime: new Date().toISOString(),
        });

        // Run the turn through the `claude` CLI (subscription auth). The CLI
        // drives its own agentic loop with native read-only tools scoped to the
        // active kshetra repo; we forward its stream-json events to the client.
        const cwd = activeKshetra?.repo.path ?? process.cwd();

        await runVicharaTurn(
          { systemPrompt, userPrompt: chatText, cwd, model: VICHARA_MODEL },
          {
            text: t => safeSend({ type: 'text_delta', text: t }),
            toolUse: (name, input) => safeSend({ type: 'tool_use', name, input }),
            toolResult: name => safeSend({ type: 'tool_result', name }),
            error: message => safeSend({ type: 'error', message }),
            done: () => safeSend({ type: 'done' }),
          },
        );
      });
    },
  );

  return { fastify, port };
}

export async function startVicharaServer(port = DEFAULT_PORT): Promise<void> {
  const { fastify } = await createVicharaServer(port);
  await fastify.listen({ port, host: '0.0.0.0' });
}