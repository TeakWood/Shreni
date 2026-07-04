import { execFile } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import type { KshetraConfig } from '../kshetra/config.js';

const execFileAsync = promisify(execFile);

// Read-only `bd` accessor for Phalaka.
//
// Deliberately exposes ONLY non-mutating commands (`list --json`, `show --json`).
// The internal write wrapper lives in src/sthapathi/beads.ts and is the sole
// owner of the `bd` write lifecycle (claim/close/create/...). Keeping a separate
// reader makes the "Sthapathi owns writes" invariant enforceable by construction:
// there is simply no mutation method on this surface.

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

// Bead ids are like `myapp-beads-9g3` or `myapp-beads-9sk.6`. Validate before
// passing to `bd show` so a path/arg-injection attempt can't reach the subprocess.
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
}

// ── Raw `bd --json` parsing (snake_case, lenient) ───────────────────────────

const RawDependencySchema = z
  .object({
    // `bd list --json` dependency rows use issue_id/depends_on_id; `bd show`
    // nests full bead objects with id/title. Accept either.
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
  // In `bd show`, the bead's own row carries `depends_on_id` links; the nested
  // dependency objects describe the parent/blockers. Surface both shapes.
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
  };
}

function parseRawArray(stdout: string): RawBead[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || '[]');
  } catch (err) {
    throw new BeadsReadError(`bd returned non-JSON output: ${(err as Error).message}`, err);
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: RawBead[] = [];
  for (const item of arr) {
    const result = RawBeadSchema.safeParse(item);
    if (result.success) out.push(result.data);
  }
  return out;
}

// ── TTL cache (in-process, per beads path + command) ────────────────────────

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

async function exec(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync('bd', args, { env, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new BeadsReadError(`bd ${args[0]} failed: ${e.stderr ?? e.message ?? String(err)}`, err);
  }
}

export interface ListFilters {
  status?: string;
}

export function beadsRead(kshetra: KshetraConfig) {
  const beadsPath = kshetra.beads.path;
  const env: NodeJS.ProcessEnv = { ...process.env, BEADS_DIR: beadsPath };

  return {
    async list(filters: ListFilters = {}): Promise<BeadSummary[]> {
      const args = ['list', '--json'];
      if (filters.status) args.push('--status', filters.status);
      const key = `${beadsPath}::list::${filters.status ?? 'default'}`;
      return cached(key, LIST_CACHE_TTL_MS, async () => parseRawArray(await exec(args, env)).map(toSummary));
    },

    async show(id: string): Promise<BeadDetail | null> {
      if (!isValidBeadId(id)) {
        throw new BeadsReadError(`invalid bead id: ${JSON.stringify(id)}`);
      }
      const key = `${beadsPath}::show::${id}`;
      return cached(key, LIST_CACHE_TTL_MS, async () => {
        const rows = parseRawArray(await exec(['show', id, '--json'], env));
        const match = rows.find(r => r.id === id) ?? rows[0];
        return match ? toDetail(match) : null;
      });
    },
  };
}

// ── Per-Kshetra error isolation ─────────────────────────────────────────────
//
// One Kshetra's broken beads DB must not blank the whole board. These helpers
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