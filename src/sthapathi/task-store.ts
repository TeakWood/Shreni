import type { KshetraConfig } from '../kshetra/config.js';
import type { PrWatermark } from './pr-followup.js';

/** The tracker calls the agent loop and error handler make. */
export interface TrackerCalls {
  /** The project's memories, rendered for a prompt. */
  prime(): Promise<string>;
  /** The task as a JSON array: the task (with acceptance_criteria), then its dependencies. */
  show(id: string): Promise<string>;
  addNote(id: string, note: string): Promise<string>;
  remember(insight: string): Promise<string>;
  flag(id: string, reason: string): Promise<string>;
}

// The task store the worker's merge, PR follow-up and agent paths write to
// (policy spec, "The lifecycle" and "Running work"). The worker registers one
// at startup, once it has opened the task graph engine.

/** A task waiting on its PR, as reconcile walks them. */
export interface AwaitingMerge { id: string; title: string; slug: string }

export interface EngineTaskStore {
  /** Verifies and extends the lease right before merging, which is outside the database. */
  beforeMerge(taskId: string): Promise<void>;
  /** The work landed on main: finish (the checksPassed guard decides). */
  finish(taskId: string, reason: string): Promise<void>;
  /** A PR is open: record it on the attempt's evidence, then submit (the hasOpenPr guard reads it). */
  deferForPr(taskId: string, prUrl: string): Promise<void>;
  /** Tasks waiting on their PR. */
  listAwaitingMerge(): Promise<AwaitingMerge[]>;
  /** The PR was closed unmerged: flag it for a human. */
  prDeclined(taskId: string, reason: string): Promise<void>;
  /** The PR has unaddressed feedback: followUp, which reopens it boosted ahead of other work. */
  needsFollowup(taskId: string): Promise<void>;
  /** A follow-up round ended with the PR still open: back to waiting on it. */
  resubmit(taskId: string, reason: string): Promise<void>;
  /** Hand the task to a human. */
  flag(taskId: string, reason: string): Promise<void>;
  note(taskId: string, text: string): Promise<void>;
  readWatermark(taskId: string): Promise<PrWatermark>;
  writeWatermark(taskId: string, w: PrWatermark): Promise<void>;
  /** prime (memories), show (the task JSON), notes, memories and flags for the agent loop. */
  tracker: TrackerCalls;
  /** The CLI's and Phalaka's reads, bd-shaped, on the worker's own connection. */
  reads?: import('../policy/sthapathi/reads.js').TrackerReads;
  /**
   * Files the health gate's repair task, as system (so it lands open), unless
   * one is already open. Returns whether it filed one.
   */
  ensureHealthTask(title: string, priority: number): Promise<boolean>;
  /**
   * Files a Parikshaka gap as agent (proposed), keyed so a gap seen twice is
   * filed once: under the source task's epic while that is open, standalone
   * once it has closed, linked discovered-from to the source task.
   */
  fileGap(gap: { title: string; description: string; priority: number; key: string; sourceTaskId?: string }): Promise<'filed' | 'exists'>;
  /** Records on the current attempt whether the task's acceptance checks passed (finish's checksPassed reads it). */
  recordAcceptance(taskId: string, passed: boolean): Promise<void>;
}

const stores = new Map<string, EngineTaskStore>();

export function registerEngineStore(kshetraId: string, store: EngineTaskStore): void {
  stores.set(kshetraId, store);
}

export function unregisterEngineStore(kshetraId: string): void {
  stores.delete(kshetraId);
}

/** No task store is registered for the Kshetra: its worker hasn't opened the engine. */
export class NoTaskStore extends Error {
  constructor(kshetraId: string) {
    super(`no task store for ${kshetraId}: the worker has not opened the task graph engine`);
    this.name = 'NoTaskStore';
  }
}

/** The Kshetra's task store when this process's worker has registered one. */
export function registeredStore(kshetra: Pick<KshetraConfig, 'id'>): EngineTaskStore | undefined {
  return stores.get(kshetra.id);
}

/** The Kshetra's task store, registered by its worker; throws NoTaskStore when there is none. */
export function engineStore(kshetra: Pick<KshetraConfig, 'id'>): EngineTaskStore {
  const store = stores.get(kshetra.id);
  if (!store) throw new NoTaskStore(kshetra.id);
  return store;
}

/** The tracker for the agent loop. */
export function trackerFor(kshetra: Pick<KshetraConfig, 'id'>): TrackerCalls {
  return engineStore(kshetra).tracker;
}
