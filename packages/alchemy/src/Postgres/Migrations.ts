import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Client } from "pg";
import type { SqlFile } from "../SQL/SqlFile.ts";

const importPg = () =>
  import("pg").catch((cause) => {
    throw new Error(
      "Failed to load the 'pg' driver. Install the optional peer dependency 'pg' to run Postgres migrations.",
      { cause },
    );
  });

export class PgError extends Data.TaggedError("PgError")<{
  message: string;
  cause?: unknown;
}> {}

export interface ApplyMigrationsOptions {
  connectionUri: Redacted.Redacted<string>;
  migrationsTable: string;
  migrationsFiles: ReadonlyArray<SqlFile>;
}

const withClient = <A, E>(
  connectionUri: Redacted.Redacted<string>,
  fn: (client: Client) => Promise<A>,
): Effect.Effect<A, PgError | E> =>
  Effect.tryPromise({
    try: async () => {
      const { Client } = await importPg();
      const client = new Client({
        connectionString: Redacted.value(connectionUri),
      });
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.end().catch(() => {});
      }
    },
    catch: (cause) =>
      new PgError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const ensureMigrationsTable = (client: Client, migrationsTable: string) =>
  client.query(
    `CREATE TABLE IF NOT EXISTS "${migrationsTable}" (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );`,
  );

const getApplied = (client: Client, migrationsTable: string) =>
  client
    .query<{ name: string }>(`SELECT name FROM "${migrationsTable}";`)
    .then((r) => new Set(r.rows.map((row) => row.name)));

const getNextSeq = (client: Client, migrationsTable: string) =>
  client
    .query<{ id: string }>(`SELECT id FROM "${migrationsTable}";`)
    .then((r) => {
      let max = 0;
      for (const { id } of r.rows) {
        if (/^\d+$/.test(id)) {
          max = Math.max(max, Number.parseInt(id, 10));
        }
      }
      return max + 1;
    });

export const applyMigrations = (options: ApplyMigrationsOptions) =>
  withClient(options.connectionUri, async (client) => {
    await ensureMigrationsTable(client, options.migrationsTable);
    const applied = await getApplied(client, options.migrationsTable);
    let nextSeq = await getNextSeq(client, options.migrationsTable);

    for (const file of options.migrationsFiles) {
      if (applied.has(file.id)) continue;
      const migrationId = nextSeq.toString().padStart(5, "0");
      nextSeq += 1;
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query(
          `INSERT INTO "${options.migrationsTable}" (id, name) VALUES ($1, $2);`,
          [migrationId, file.id],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
  });

export const runSql = (connectionUri: Redacted.Redacted<string>, sql: string) =>
  withClient(connectionUri, async (client) => {
    await client.query(sql);
  });
