import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { loadRegistry } from '../kshetra/registry.js';
import { loadState } from '../kshetra/state.js';
import { readToken } from './token.js';
import { VICHARA_TOOLS, executeTool } from './tools.js';
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

export async function createVicharaServer(port = DEFAULT_PORT) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — export it before running shreni vichara start');
  }

  const client = new Anthropic();
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

        const messages: MessageParam[] = [{ role: 'user', content: chatText }];

        try {
          let iterations = 0;
          const MAX_ITERATIONS = 10;

          while (iterations < MAX_ITERATIONS) {
            iterations++;
            const response = await client.messages.create({
              model: 'claude-sonnet-4-6',
              max_tokens: 4096,
              system: systemPrompt,
              tools: VICHARA_TOOLS,
              messages,
            });

            messages.push({ role: 'assistant', content: response.content });

            if (response.stop_reason === 'tool_use') {
              const toolResults: MessageParam['content'] = [];

              for (const block of response.content) {
                if (block.type !== 'tool_use') continue;

                safeSend({ type: 'tool_use', id: block.id, name: block.name, input: block.input });

                const result = await executeTool(
                  block.name,
                  block.input as Record<string, string>,
                  kshetras,
                );

                safeSend({ type: 'tool_result', id: block.id, name: block.name });

                (toolResults as Array<{ type: 'tool_result'; tool_use_id: string; content: string }>).push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: result,
                });
              }

              messages.push({ role: 'user', content: toolResults });
              continue;
            }

            const textBlock = response.content.find(b => b.type === 'text');
            if (textBlock?.type === 'text') {
              safeSend({ type: 'text_delta', text: textBlock.text });
            }
            break;
          }

          safeSend({ type: 'done' });
        } catch (err) {
          safeSend({ type: 'error', message: (err as Error).message });
        }
      });
    },
  );

  return { fastify, port };
}

export async function startVicharaServer(port = DEFAULT_PORT): Promise<void> {
  const { fastify } = await createVicharaServer(port);
  await fastify.listen({ port, host: '0.0.0.0' });
}