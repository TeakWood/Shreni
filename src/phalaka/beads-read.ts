import { z } from 'zod';
import type { KshetraConfig } from '../kshetra/config.js';
import { withTrackerReads } from '../policy/sthapathi/reads.js';

// Read-only task accessor for Phalaka, over the task graph engine's reads.
//
// Deliberately exposes ONLY reads (list, show). Sthapathi owns every write;
// keeping a separate reader makes the "Sthapathi owns writes" invariant
// enforceable by construction: there is simply no mutation method on this surface.

export const LIST_CACHE_TTL_MS = 5_000;

export class BeadsReadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BeadsReadError';
  }
}

// Task ids are like `myapp-9g3` or `myapp-9sk.6`. Validate before a read, so a
// malformed id is refused up front.
const BEAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidBeadId(id: string): boolean {
  return BEAD_ID_RE.test(id) && id.length <= 128;
}

// ── Public (camelCase) shapes returned to callers ───────────────────────────

export interface BeadSummary {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  assignee?: string;
  updatedAt: string;
}

export interface BeadDependency {
  id: string;
  title?: string;
  type?: string;
}

export interface BeadDetail extends BeadSummary {
  description?: string;
  notes?: string;
  design?: string;
  acceptance?: string;
  createdAt: string;
  dependencies: BeadDependency[];
  blockedBy: string[];
  parent?: string;
  // Labels ride on the detail surface only (e.g. `pr-needs-followup`).
  labels: string[];
}

// ── Raw task-row parsing (snake_case, lenient) ──────────────────────────────

const RawDependencySchema = z
  .object({
    // Dependency rows use issue_id/depends_on_id, or nest full task objects
    // with id/title. Accept either.
    id: z.string().optional(),
    issue_id: z.string().optional(),
    depends_on_id: z.string().optional(),
    title: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const RawBeadSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    status: z.string().optional(),
    priority: z.number().optional(),
    issue_type: z.string().optional(),
    owner: z.string().optional(),
    assignee: z.string().optional(),
    description: z.string().optional(),
    notes: z.string().optional(),
    design: z.string().optional(),
    acceptance_criteria: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    dependencies: z.array(RawDependencySchema).optional(),
    parent: z.string().optional(),
    labels: z.array(z.string()).optional(),
  })
  .passthrough();

type RawBead = z.infer<typeof RawBeadSchema>;

function toSummary(raw: RawBead): BeadSummary {
  return {
    id: raw.id,
    title: raw.title ?? '',
    status: raw.status ?? 'unknown',
    priority: raw.priority ?? 4,
    type: raw.issue_type ?? 'task',
    assignee: raw.assignee ?? raw.owner,
    updatedAt: raw.updated_at ?? raw.created_at ?? '',
  };
}

function toDetail(raw: RawBead): BeadDetail {
  // The task's own row carries `depends_on_id` links; the nested dependency
  // objects describe the parent/blockers. Surface both shapes.
  const deps: BeadDependency[] = (raw.dependencies ?? [])
    .map(d => ({ id: d.id ?? d.depends_on_id ?? d.issue_id ?? '', title: d.title, type: d.type }))
    .filter(d => d.id !== '');
  const blockedBy = deps.filter(d => d.type !== 'parent-child').map(d => d.id);

  return {
    ...toSummary(raw),
    description: raw.description,
    notes: raw.notes,
    design: raw.design,
    acceptance: raw.acceptance_criteria,
    createdAt: raw.created_at ?? '',
    dependencies: deps,
    blockedBy,
    parent: raw.parent,
    labels: raw.labels ?? [],
  };
}

function parseRawArray(stdout: string): RawBead[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || '[]');
  } catch (err) {
    throw new BeadsReadError(`the task read returned non-JSON output: ${(err as Error).message}`, err);
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: RawBead[] = [];
  for (const item of arr) {
    const result = RawBeadSchema.safeParse(item);
    if (result.success) out.push(result.data);
  }
  return out;
}

// ── TTL cache (in-process, per project + read) ──────────────────────────────

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

// Exposed for test isolation; not used in production paths.
export function clearBeadsReadCache(): void {
  cache.clear();
}

async function cached<T>(key: string, ttl: number, produce: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.value as T;
  }
  const value = await produce();
  cache.set(key, { expires: Date.now() + ttl, value });
  return value;
}

export interface ListFilters {
  status?: string;
  // A label filter, applied by the read, so a label-filtered list returns only
  // matching tasks even though each row's own JSON omits its labels.
  label?: string;
}

export function beadsRead(kshetra: KshetraConfig) {
  // The rows come from a connection Phalaka keeps (still polling, through this
  // cache, until change notifications come).
  const source = `engine:${kshetra.project}`;
  const engine = async (fn: Parameters<typeof withTrackerReads<string>>[1]): Promise<string> => {
    try {
      return await withTrackerReads(kshetra, fn, { shared: true });
    } catch (err) {
      throw new BeadsReadError(`task graph read failed: ${(err as Error).message}`, err);
    }
  };

  return {
    async list(filters: ListFilters = {}): Promise<BeadSummary[]> {
      // Every row, never capped: the board and the per-kshetra counts need every
      // task (Shreni-beads-8ym). The cache key MUST carry every filter — a label-filtered list must not
      // collide with (and return) the unfiltered 'default' slice.
      const key = `${source}::list::${filters.status ?? 'default'}::${filters.label ?? ''}`;
      return cached(key, LIST_CACHE_TTL_MS, async () => parseRawArray(
        await engine(r => r.list({ ...(filters.status ? { status: filters.status } : {}), ...(filters.label ? { label: filters.label } : {}) })),
      ).map(toSummary));
    },

    async show(id: string): Promise<BeadDetail | null> {
      if (!isValidBeadId(id)) {
        throw new BeadsReadError(`invalid bead id: ${JSON.stringify(id)}`);
      }
      const key = `${source}::show::${id}`;
      return cached(key, LIST_CACHE_TTL_MS, async () => {
        const rows = parseRawArray(await engine(r => r.show(id)));
        const match = rows.find(r => r.id === id) ?? rows[0];
        return match ? toDetail(match) : null;
      });
    },
  };
}

// ── Per-Kshetra error isolation ─────────────────────────────────────────────
//
// One Kshetra's failing read must not blank the whole board. These helpers
// return a discriminated result instead of throwing, so the server can render
// every healthy Kshetra and surface the failing one's `error` inline.

export type KshetraTasksResult =
  | { kshetra: KshetraConfig; tasks: BeadSummary[] }
  | { kshetra: KshetraConfig; error: string };

export async function readKshetraTasks(
  kshetra: KshetraConfig,
  filters: ListFilters = {},
): Promise<KshetraTasksResult> {
  try {
    const tasks = await beadsRead(kshetra).list(filters);
    return { kshetra, tasks };
  } catch (err) {
    return { kshetra, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function readAllKshetraTasks(
  kshetras: KshetraConfig[],
  filters: ListFilters = {},
): Promise<KshetraTasksResult[]> {
  return Promise.all(kshetras.map(k => readKshetraTasks(k, filters)));
}