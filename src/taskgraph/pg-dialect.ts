import {
  CompiledQuery, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type DatabaseConnection, type Dialect, type Driver, type Kysely, type QueryResult, type TransactionSettings,
} from 'kysely';
import type postgres from 'postgres';

// A Kysely dialect over postgres.js (engine spec, "Build vs. reuse"): Kysely has
// none of its own. A query outside a transaction runs on the pool; a
// transaction reserves one postgres.js connection, so its statements share a
// session. Driver errors pass through as postgres.js raises them, keeping the
// SQLSTATE in `code`.

export interface PostgresJsDialectConfig {
  /** The caller's postgres.js instance; the caller owns it and ends it. */
  sql: postgres.Sql;
}

export class PostgresJsDialect implements Dialect {
  constructor(private readonly config: PostgresJsDialectConfig) {
    // Engine code reads snake_case columns with postgres.js's default values.
    const t = config.sql.options.transform;
    if (t?.column?.from || t?.value?.from || t?.row?.from) {
      throw new TypeError('taskgraph needs a postgres.js instance without column, value or row transforms');
    }
  }
  createAdapter() { return new PostgresAdapter(); }
  createDriver(): Driver { return new PostgresJsDriver(this.config.sql); }
  createIntrospector(db: Kysely<any>) { return new PostgresIntrospector(db); }
  createQueryCompiler() { return new PostgresQueryCompiler(); }
}

class PostgresJsDriver implements Driver {
  constructor(private readonly sql: postgres.Sql) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new PostgresJsConnection(this.sql);
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    await (connection as PostgresJsConnection).reserve();
    let begin = 'begin';
    if (settings.isolationLevel || settings.accessMode) {
      begin = 'start transaction';
      if (settings.isolationLevel) begin += ` isolation level ${settings.isolationLevel}`;
      if (settings.accessMode) begin += ` ${settings.accessMode}`;
    }
    await connection.executeQuery(CompiledQuery.raw(begin));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as PostgresJsConnection).release();
  }

  /** The caller owns the postgres.js instance, so destroying Kysely leaves it open. */
  async destroy(): Promise<void> {}
}

class PostgresJsConnection implements DatabaseConnection {
  private reserved?: postgres.ReservedSql;

  constructor(private readonly sql: postgres.Sql) {}

  /** Holds one connection until release, for a transaction. */
  async reserve(): Promise<void> {
    this.reserved ??= await this.sql.reserve();
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const result = await (this.reserved ?? this.sql).unsafe(query.sql, query.parameters as any[]);
    const rows = [...result] as R[];
    const affects = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(result.command);
    return affects ? { rows, numAffectedRows: BigInt(result.count) } : { rows };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('taskgraph: streaming queries are not supported');
  }

  release(): void {
    this.reserved?.release();
    this.reserved = undefined;
  }
}
