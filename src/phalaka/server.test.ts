import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { KshetraConfig } from '../kshetra/config.js';
import type { BeadSummary, BeadDetail, KshetraTasksResult } from './beads-read.js';

// ── module mocks ─────────────────────────────────────────────────────────────

const mockLoadRegistry = vi.fn<() => KshetraConfig[]>();
vi.mock('../kshetra/registry.js', () => ({ loadRegistry: mockLoadRegistry }));

const mockReadToken = vi.fn<() => string | null>();
vi.mock('./token.js', () => ({ readToken: mockReadToken }));

const mockLoadState = vi.fn<() => { kshetras: Record<string, unknown> }>();
vi.mock('../kshetra/state.js', () => ({ loadState: mockLoadState }));

const mockList = vi.fn<(filters?: { status?: string }) => Promise<BeadSummary[]>>();
const mockShow = vi.fn<(id: string) => Promise<BeadDetail | null>>();
const mockReadKshetraTasks = vi.fn<() => Promise<KshetraTasksResult>>();
vi.mock('./beads-read.js', async () => {
  const actual = await vi.importActual<typeof import('./beads-read.js')>('./beads-read.js');
  return {
    ...actual,
    beadsRead: () => ({ list: mockList, show: mockShow }),
    readKshetraTasks: (...args: unknown[]) => mockReadKshetraTasks(...(args as [])),
  };
});

const mockReadNotifications = vi.fn<() => unknown[]>();
vi.mock('../sthapathi/notifications.js', () => ({ readNotifications: mockReadNotifications }));

const { createPhalakaServer } = await import('./server.js');
const { PHALAKA_VERSION, KshetraListSchema, TaskListResponseSchema, BeadDetailSchema, NotificationListResponseSchema } =
  await import('./api.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const TOKEN = 'secret-token';

const KSHETRA: KshetraConfig = {
  id: 'myapp',
  name: 'Myapp',
  repo: { path: '/projects/myapp', remote: '', mainBranch: 'main', branchPattern: 'bead-{id}/{slug}' },
  beads: { path: '/projects/myapp-beads', remote: '', mode: 'embedded' },
  stack: { language: 'typescript' },
  conventions: {},
  agents: { provider: 'anthropic', model: 'claude-sonnet-4', maxRoundsPerBead: 3 },
  priority: { p0AutoAssign: true, maxConcurrentBeads: 1 },
};

const SUMMARY: BeadSummary = {
  id: 'proj-1',
  title: 'First task',
  status: 'open',
  priority: 1,
  type: 'feature',
  assignee: 'dev@example.com',
  updatedAt: '2026-06-29T00:00:00Z',
};

const DETAIL: BeadDetail = {
  ...SUMMARY,
  description: 'Do the thing',
  createdAt: '2026-06-28T00:00:00Z',
  dependencies: [{ id: 'proj-0', title: 'Parent', type: 'parent-child' }],
  blockedBy: [],
  parent: 'proj-0',
};

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockReadToken.mockReturnValue(TOKEN);
  mockLoadRegistry.mockReturnValue([KSHETRA]);
  mockLoadState.mockReturnValue({ kshetras: {} });
  mockReadNotifications.mockReturnValue([]);
  ({ fastify: app } = await createPhalakaServer());
});

describe('GET /', () => {
  it('serves the dashboard HTML without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Phalaka');
  });
});

describe('GET /api/health', () => {
  it('returns ok + version without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: PHALAKA_VERSION });
  });
});

describe('auth gating', () => {
  it('401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/kshetras' });
    expect(res.statusCode).toBe(401);
  });

  it('401 with a wrong token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/kshetras?token=nope' });
    expect(res.statusCode).toBe(401);
  });

  it('200 with the right token via query', async () => {
    mockList.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: `/api/kshetras?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
  });

  it('200 with the right token via Bearer header', async () => {
    mockList.mockResolvedValue([]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/kshetras',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/kshetras', () => {
  it('returns counts that validate against the zod schema', async () => {
    // active list: 2 open, 1 in_progress, 1 blocked; closed list: 3
    mockList.mockImplementation(async (filters?: { status?: string }) => {
      if (filters?.status === 'closed') {
        return [3, 4, 5].map(n => ({ ...SUMMARY, id: `c-${n}`, status: 'closed' }));
      }
      return [
        { ...SUMMARY, id: 'a', status: 'open' },
        { ...SUMMARY, id: 'b', status: 'open' },
        { ...SUMMARY, id: 'c', status: 'in_progress' },
        { ...SUMMARY, id: 'd', status: 'blocked' },
      ];
    });
    const res = await app.inject({ method: 'GET', url: `/api/kshetras?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const body = KshetraListSchema.parse(res.json());
    expect(body[0]!.counts).toEqual({ open: 2, in_progress: 1, blocked: 1, closed: 3 });
  });

  it('surfaces worker phase and the stuck banner from state', async () => {
    mockList.mockResolvedValue([]);
    mockLoadState.mockReturnValue({
      kshetras: {
        myapp: {
          paused: true,
          phase: 'PREPARING',
          stuck: { since: '2026-06-30T00:00:00Z', reason: 'agent hung', remediation: '  1) restart it', extra: 'ignored' },
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: `/api/kshetras?token=${TOKEN}` });
    const body = KshetraListSchema.parse(res.json());
    expect(body[0]!.phase).toBe('PREPARING');
    expect(body[0]!.paused).toBe(true);
    expect(body[0]!.stuck).toEqual({ since: '2026-06-30T00:00:00Z', reason: 'agent hung', remediation: '  1) restart it' });
  });

  it('carries an error field for a Kshetra whose bd fails (partial failure)', async () => {
    mockLoadRegistry.mockReturnValue([KSHETRA, { ...KSHETRA, id: 'broken', name: 'Broken' }]);
    mockList.mockImplementation(async () => {
      // healthy kshetra resolves; broken one rejects — but only the broken
      // entry should carry error, the healthy one still renders counts.
      return [];
    });
    // Make the second kshetra's calls reject.
    let call = 0;
    mockList.mockImplementation(async () => {
      call++;
      // first kshetra: 2 calls (active+closed) ok; second kshetra: throw
      if (call > 2) throw new Error('database is locked');
      return [];
    });
    const res = await app.inject({ method: 'GET', url: `/api/kshetras?token=${TOKEN}` });
    const body = KshetraListSchema.parse(res.json());
    expect(body).toHaveLength(2);
    expect(body[0]!.error).toBeUndefined();
    expect(body[0]!.counts).toBeDefined();
    expect(body[1]!.error).toContain('database is locked');
    expect(body[1]!.counts).toBeUndefined();
  });
});

describe('GET /api/kshetras/:id/tasks', () => {
  it('200 with task list for a known Kshetra', async () => {
    mockReadKshetraTasks.mockResolvedValue({ kshetra: KSHETRA, tasks: [SUMMARY] });
    const res = await app.inject({ method: 'GET', url: `/api/kshetras/myapp/tasks?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const body = TaskListResponseSchema.parse(res.json());
    expect(body.tasks).toHaveLength(1);
    expect(body.error).toBeUndefined();
  });

  it('surfaces an error field when that Kshetra bd fails', async () => {
    mockReadKshetraTasks.mockResolvedValue({ kshetra: KSHETRA, error: 'bd list failed: boom' });
    const res = await app.inject({ method: 'GET', url: `/api/kshetras/myapp/tasks?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const body = TaskListResponseSchema.parse(res.json());
    expect(body.tasks).toEqual([]);
    expect(body.error).toContain('boom');
  });

  it('404 for an unknown Kshetra', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/kshetras/ghost/tasks?token=${TOKEN}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/kshetras/:id/notifications', () => {
  const NOTIF = { ts: '2026-06-30T09:35:00Z', event: 'stuck', beadId: 'b1', reason: 'agent hung', message: '[Myapp] STUCK' };

  it('401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/kshetras/myapp/notifications' });
    expect(res.statusCode).toBe(401);
  });

  it('404 for an unknown Kshetra', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/kshetras/ghost/notifications?token=${TOKEN}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns the feed validated against the schema', async () => {
    mockReadNotifications.mockReturnValue([NOTIF]);
    const res = await app.inject({ method: 'GET', url: `/api/kshetras/myapp/notifications?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const body = NotificationListResponseSchema.parse(res.json());
    expect(body.kshetraId).toBe('myapp');
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]!.event).toBe('stuck');
  });

  it('forwards since + a valid limit to the reader', async () => {
    mockReadNotifications.mockReturnValue([]);
    await app.inject({
      method: 'GET',
      url: `/api/kshetras/myapp/notifications?token=${TOKEN}&since=2026-06-30T09:00:00Z&limit=5`,
    });
    expect(mockReadNotifications).toHaveBeenCalledWith('myapp', { sinceTs: '2026-06-30T09:00:00Z', limit: 5 });
  });

  it('ignores a non-numeric limit (passes undefined)', async () => {
    mockReadNotifications.mockReturnValue([]);
    await app.inject({ method: 'GET', url: `/api/kshetras/myapp/notifications?token=${TOKEN}&limit=abc` });
    expect(mockReadNotifications).toHaveBeenCalledWith('myapp', { sinceTs: undefined, limit: undefined });
  });
});

describe('GET /api/kshetras/:id/tasks/:beadId', () => {
  it('200 with full detail validating against the schema', async () => {
    mockShow.mockResolvedValue(DETAIL);
    const res = await app.inject({ method: 'GET', url: `/api/kshetras/myapp/tasks/proj-1?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(() => BeadDetailSchema.parse(res.json())).not.toThrow();
  });

  it('404 for an unknown Kshetra', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/kshetras/ghost/tasks/proj-1?token=${TOKEN}` });
    expect(res.statusCode).toBe(404);
  });

  it('400 for an invalid bead id (no shelling out)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/kshetras/myapp/tasks/${encodeURIComponent('--status closed')}?token=${TOKEN}`,
    });
    expect(res.statusCode).toBe(400);
    expect(mockShow).not.toHaveBeenCalled();
  });

  it('404 when bd has no such bead', async () => {
    mockShow.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: `/api/kshetras/myapp/tasks/proj-404?token=${TOKEN}` });
    expect(res.statusCode).toBe(404);
  });
});