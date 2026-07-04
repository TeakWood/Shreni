import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadRegistry } from '../kshetra/registry.js';
import { loadState } from '../kshetra/state.js';
import { readToken } from './token.js';
import { beadsRead, readKshetraTasks, isValidBeadId } from './beads-read.js';
import { readNotifications } from '../sthapathi/notifications.js';
import type { KshetraConfig } from '../kshetra/config.js';

export const PHALAKA_VERSION = '1.0.0';

// ── Response schemas (zod) ──────────────────────────────────────────────────

export const CountsSchema = z.object({
  open: z.number().int().nonnegative(),
  in_progress: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});

export const StuckSchema = z.object({
  since: z.string(),
  reason: z.string(),
  remediation: z.string(),
});

export const KshetraSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  counts: CountsSchema.optional(),
  // Worker phase + health, from state.json — so the board shows what the worker
  // is doing and, when stuck, why + how to fix it.
  phase: z.string().optional(),
  paused: z.boolean().optional(),
  stuck: StuckSchema.optional(),
  // One Kshetra's broken beads DB surfaces here instead of blanking the board.
  error: z.string().optional(),
});

export const KshetraListSchema = z.array(KshetraSummarySchema);

export const BeadSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.number(),
  type: z.string(),
  assignee: z.string().optional(),
  updatedAt: z.string(),
});

export const TaskListResponseSchema = z.object({
  kshetraId: z.string(),
  tasks: z.array(BeadSummarySchema),
  error: z.string().optional(),
});

export const BeadDependencySchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  type: z.string().optional(),
});

export const BeadDetailSchema = BeadSummarySchema.extend({
  description: z.string().optional(),
  notes: z.string().optional(),
  design: z.string().optional(),
  acceptance: z.string().optional(),
  createdAt: z.string(),
  dependencies: z.array(BeadDependencySchema),
  blockedBy: z.array(z.string()),
  parent: z.string().optional(),
});

export const NotificationSchema = z.object({
  ts: z.string(),
  event: z.string(),
  beadId: z.string().optional(),
  reason: z.string().optional(),
  remediation: z.string().optional(),
  message: z.string(),
});

export const NotificationListResponseSchema = z.object({
  kshetraId: z.string(),
  notifications: z.array(NotificationSchema),
});

export const HealthSchema = z.object({ ok: z.literal(true), version: z.string() });

// ── Auth ────────────────────────────────────────────────────────────────────

function extractToken(req: FastifyRequest): string | null {
  const q = (req.query as { token?: unknown } | undefined)?.token;
  if (typeof q === 'string' && q.length > 0) return q;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t.length > 0) return t;
  }
  return null;
}

// Returns true when the request is authorized; otherwise replies 401 and
// returns false so the handler can bail.
function requireToken(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = readToken();
  const provided = extractToken(req);
  if (!expected || provided !== expected) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function findKshetra(id: string): KshetraConfig | null {
  return loadRegistry().find(k => k.id === id) ?? null;
}

async function summarizeKshetra(kshetra: KshetraConfig): Promise<z.infer<typeof KshetraSummarySchema>> {
  try {
    const reader = beadsRead(kshetra);
    // Active list (open/in_progress/blocked/deferred) + closed list, so the
    // counts cover every status without a wide-open `bd list --all`.
    const [active, closed] = await Promise.all([reader.list(), reader.list({ status: 'closed' })]);
    const counts = { open: 0, in_progress: 0, blocked: 0, closed: closed.length };
    for (const t of active) {
      if (t.status === 'open') counts.open++;
      else if (t.status === 'in_progress') counts.in_progress++;
      else if (t.status === 'blocked') counts.blocked++;
    }
    const ks = loadState().kshetras[kshetra.id];
    return {
      id: kshetra.id,
      name: kshetra.name,
      counts,
      phase: ks?.phase,
      paused: ks?.paused,
      stuck: ks?.stuck ? { since: ks.stuck.since, reason: ks.stuck.reason, remediation: ks.stuck.remediation } : undefined,
    };
  } catch (err) {
    return { id: kshetra.id, name: kshetra.name, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerPhalakaApi(app: FastifyInstance): void {
  // Health is unauthenticated (carries no task data).
  app.get('/api/health', async () => HealthSchema.parse({ ok: true, version: PHALAKA_VERSION }));

  app.get('/api/kshetras', async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const summaries = await Promise.all(loadRegistry().map(summarizeKshetra));
    return KshetraListSchema.parse(summaries);
  });

  app.get('/api/kshetras/:id/tasks', async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const kshetra = findKshetra(id);
    if (!kshetra) return reply.code(404).send({ error: `unknown kshetra: ${id}` });

    const status = (req.query as { status?: string } | undefined)?.status;
    const result = await readKshetraTasks(kshetra, status ? { status } : {});
    if ('error' in result) {
      return TaskListResponseSchema.parse({ kshetraId: id, tasks: [], error: result.error });
    }
    return TaskListResponseSchema.parse({ kshetraId: id, tasks: result.tasks });
  });

  app.get('/api/kshetras/:id/notifications', async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const kshetra = findKshetra(id);
    if (!kshetra) return reply.code(404).send({ error: `unknown kshetra: ${id}` });

    const query = req.query as { since?: string; limit?: string } | undefined;
    const sinceTs = query?.since;
    const parsedLimit = query?.limit !== undefined ? Number(query.limit) : undefined;
    const limit =
      parsedLimit !== undefined && Number.isInteger(parsedLimit) && parsedLimit >= 0
        ? parsedLimit
        : undefined;

    const notifications = readNotifications(id, { sinceTs, limit });
    return NotificationListResponseSchema.parse({ kshetraId: id, notifications });
  });

  app.get('/api/kshetras/:id/tasks/:beadId', async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id, beadId } = req.params as { id: string; beadId: string };
    const kshetra = findKshetra(id);
    if (!kshetra) return reply.code(404).send({ error: `unknown kshetra: ${id}` });
    if (!isValidBeadId(beadId)) return reply.code(400).send({ error: 'invalid bead id' });

    try {
      const detail = await beadsRead(kshetra).show(beadId);
      if (!detail) return reply.code(404).send({ error: `unknown bead: ${beadId}` });
      return BeadDetailSchema.parse(detail);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}