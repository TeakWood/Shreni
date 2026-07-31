// TS mirrors of the zod response schemas in src/phalaka/api.ts. Kept as plain
// hand-written types (not generated) so the web app carries no build-time
// dependency on the backend package. If a schema in api.ts changes, update here.

export interface Counts {
  open: number;
  in_progress: number;
  blocked: number;
  closed: number;
}

export interface Stuck {
  since: string;
  reason: string;
  remediation: string;
}

export interface KshetraSummary {
  id: string;
  name: string;
  counts?: Counts;
  phase?: string;
  paused?: boolean;
  stuck?: Stuck;
  /** Count of beads awaiting an open-PR follow-up pass. */
  followup?: number;
  /** One Kshetra's broken beads DB surfaces here instead of blanking the board. */
  error?: string;
}

export interface BeadSummary {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  assignee?: string;
  updatedAt: string;
}

export interface TaskListResponse {
  kshetraId: string;
  tasks: BeadSummary[];
  error?: string;
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
  labels: string[];
}

// Mirrors PauseActionResponseSchema / ResumeActionResponseSchema in api.ts — the
// bodies the two POST action routes return. resumed_needs_start carries the
// `shreni start` command to run when no live worker was present to self-heal.
export interface PauseActionResponse {
  status: 'paused';
  id: string;
}

export type ResumeActionResponse =
  | { status: 'resumed'; id: string }
  | { status: 'resumed_self_heal'; id: string }
  | { status: 'resumed_needs_start'; id: string; hint: string };

export type ActionResponse = PauseActionResponse | ResumeActionResponse;

export type KshetraAction = 'pause' | 'resume';

export type ProcessKind = 'worker' | 'phalaka' | 'suthradhara';

export type ProcessStatus =
  | 'working'
  | 'idle'
  | 'paused-manual'
  | 'stuck'
  | 'stale-heartbeat'
  | 'dead'
  | 'healthy';

export interface ProcessStuck {
  since: string;
  reason: string;
  remediation: string;
  phase?: string;
  beadId?: string;
}

export interface ProcessActiveBead {
  id: string;
  title: string;
  agent?: string;
  round?: number;
}

export interface ProcessSnapshot {
  kind: ProcessKind;
  kshetraId?: string;
  pid: number;
  status: ProcessStatus;
  phase?: string;
  heartbeatAgeMs?: number;
  paused: boolean;
  stuck?: ProcessStuck;
  activeBead?: ProcessActiveBead;
  queueDepth?: number;
  lastProgressAt?: string;
  error?: string;
}
