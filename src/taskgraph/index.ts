// The task graph engine (docs/architecture/task-graph-engine.md): mechanism
// only — it stores the graph, enforces the lifecycle Shreni declares, and knows
// nothing about building software.
//
// Boundary: nothing in this directory imports from the rest of Shreni. Only Node
// built-ins and the libraries the spec adopts are allowed, enforced by
// boundary.test.ts.

export { openTaskGraph } from './client';
export type { OpenTaskGraphOptions, Project, TaskGraphClient, ProjectHandle, ActorHandle } from './client';
export { defineLifecycle, defineGuard, SYSTEM_ROLE, CALLS } from './lifecycle';
export type { Lifecycle, Move, Guard, GuardFn, StateFlags, Call } from './lifecycle';
export type { MigrationReport } from './migrate';
export type { Actor, Task, TaskDetail, TaskFilter, Plan, PlanFilter, Attempt, TaskGraphEvent } from './types';
export type { NewTask, TaskPatch, WriteOptions } from './tasks';
export type { MoveOptions } from './moves';
export { BUNDLE_FORMAT } from './bundle';
export type { ProjectBundle, BundleTask, BundlePlan, BundleEvent, ImportReport, ImportCallback, PurgeReport } from './bundle';
export * from './errors';
