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
