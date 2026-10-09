import { inject, onTestFinished } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'crypto';
import { openTaskGraph, type TaskGraphClient } from '../client';
import { testLifecycle } from './lifecycle';
import type { Lifecycle } from '../lifecycle';

// Real-Postgres helpers for the concurrency tier: a fresh database per test,
// and clients that each hold their own connections, as separate processes do.

/** A new, empty database on the run's server; dropped when the test ends. */
export async function freshDatabase(): Promise<string> {
  const admin = postgres(inject('pgUrl'), { max: 1, onnotice: () => {} });
  const name = `tg_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(inject('pgUrl'));
  url.pathname = `/${name}`;
  onTestFinished(async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end({ timeout: 5 });
  });
  return url.toString();
}

export type Process = { client: TaskGraphClient; sql: postgres.Sql; session: postgres.Sql };

/**
 * A client as one process opens it: its own pool and its own session
 * connection. `end()` closes both connections without the client's close,
 * as a crashed process would.
 */
export async function openProcess(url: string, lifecycle: Lifecycle = testLifecycle(), poolSize = 4): Promise<Process & { end(): Promise<void> }> {
  const sql = postgres(url, { max: poolSize, onnotice: () => {} });
  const session = postgres(url, { max: 1, max_lifetime: null, idle_timeout: 0, onnotice: () => {} });
  const client = await openTaskGraph({ sql, session, lifecycle });
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    await sql.end({ timeout: 1 });
    await session.end({ timeout: 1 });
  };
  onTestFinished(async () => {
    if (!ended) await client.close().catch(() => {});
    await end();
  });
  return { client, sql, session, end };
}

/** A migrated database with one project, and `n` processes on it. */
export async function openProcesses(n: number, lifecycle?: Lifecycle) {
  const url = await freshDatabase();
  const procs = [];
  for (let i = 0; i < n; i++) procs.push(await openProcess(url, lifecycle));
  await procs[0].client.migrate();
  const project = await procs[0].client.projects.create({ name: 'web', idPrefix: 'web', actor: { id: 'setup', role: 'developer' } });
  return { url, procs, projectId: project.id, tg: (i: number) => procs[i].client.project(project.id) };
}
