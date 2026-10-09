import type { TestProject } from 'vitest/node';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Global setup for the concurrency tier: one Postgres for the run. Tests reach
// it through inject('pgUrl') and make their own databases on it.

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  let url = process.env.TASKGRAPH_TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    url = container.getConnectionUri();
  }
  project.provide('pgUrl', url);
}

export async function teardown() {
  await container?.stop();
}
