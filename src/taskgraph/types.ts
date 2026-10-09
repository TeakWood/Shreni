// Shapes shared across the engine.

/** Who makes a call: an id, and a role the lifecycle uses. */
export type Actor = { id: string; role: string };

/** A row of taskgraph.tasks (engine spec, "Data model"). */
export type Task = {
  projectId: string;
  id: string;
  key: string | null;
  planId: string | null;
  parentId: string | null;
  kind: 'work' | 'container';
  category: string | null;
  title: string;
  description: string | null;
  priority: number;
  state: string;
  origin: 'plan' | 'manual' | 'system' | 'agent' | 'imported';
  spec: Record<string, unknown>;
  tags: string[];
  boosted: boolean;
  holdUntil: Date | null;
  nextChild: number;
  leaseAttemptId: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};

/** A task with what tasks.get adds: its dependencies' states and its live claim. */
export type TaskDetail = Task & {
  deps: { id: string; state: string }[];
  claim: {
    attemptId: string; worker: string; actor: string; startedAt: Date; expiresAt: Date;
    /** The lease has lapsed by the database's clock; the holder keeps it until the sweep runs. */
    expired: boolean;
  } | null;
};

/** Which plans plans.list returns: open (neither approved nor discarded), approved or discarded. */
export type PlanFilter = { status?: ('open' | 'approved' | 'discarded')[] };

/** Which tasks a list, count or ready read returns. Every field narrows; none means all. */
export type TaskFilter = {
  states?: string[];
  kind?: 'work' | 'container';
  ids?: string[];
  key?: string;
  /** Direct children of this task. */
  parent?: string;
  /** Every task below this one, at any depth. */
  within?: string;
  plan?: string;
  origin?: Task['origin'][];
  /** Tasks carrying every one of these tags. */
  tags?: string[];
  /** claim (the default): boosted, then priority, then age; the others oldest first. */
  orderBy?: 'claim' | 'created' | 'updated' | 'closed';
  /** No limit unless given. */
  limit?: number;
};

/** A row of taskgraph.plans. */
export type Plan = {
  projectId: string;
  id: string;
  title: string;
  meta: Record<string, unknown>;
  approvedAt: Date | null;
  approvedBy: string | null;
  discardedAt: Date | null;
  discardedBy: string | null;
  createdAt: Date;
};

/** A row of taskgraph.attempts: one worker's try at a task. */
export type Attempt = {
  id: string;
  taskId: string;
  worker: string;
  actor: string;
  startedAt: Date;
  endedAt: Date | null;
  /** The move that ended it. */
  outcome: string | null;
};

/** A row of taskgraph.events. `id` is a bigint, as a string: the cursor for events.since. */
export type TaskGraphEvent = {
  id: string;
  projectId: string;
  taskId: string | null;
  planId: string | null;
  attemptId: string | null;
  kind: string;
  actor: string;
  actorRole: string;
  fromState: string | null;
  toState: string | null;
  payload: Record<string, unknown>;
  requestId: string | null;
  at: Date;
};
