import { D1 } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { SERVICE_D1 } from "@alchemy.run/cloudflare-runtime/core/bindings/d1/D1Options";
/**
 * Node-side query path into the local workerd D1 simulator, built on the
 * runtime's platform proxy (`PlatformProxy.open` — our `getPlatformProxy`).
 *
 * The simulator (a `d1` service routing to a per-database
 * `D1DatabaseObject` Durable Object over DO SQLite) is only reachable from
 * inside workerd — but alchemy's migration runner and the
 * `QueryDatabaseLocal` capability run in Node. The platform proxy bridges
 * the two: it hosts the binding in a scoped workerd instance and exposes it
 * to Node. We bind the raw `d1` service (the same designator the
 * `cloudflare-internal:d1-api` wrapped binding targets) so Node speaks the
 * full D1 HTTP protocol (`POST /query`, multi-statement SQL) rather than
 * the line-based `exec()` surface of the wrapped binding:
 *
 *   Node ── proxy.env.D1_RAW.fetch({sql}) ──▶ `d1` service ──▶ D1DatabaseObject
 *
 * Data lands in the same `{storage}/d1` directory every local worker
 * binding reads.
 *
 * NOT exported from `index.ts` — provider-internal scaffolding.
 */
import { open } from "@alchemy.run/cloudflare-runtime/core/platform-proxy";
import type { BindingHook } from "@alchemy.run/cloudflare-runtime/core/PluginContext";
import { splitSqliteStatements } from "@alchemy.run/sql/SqlFile";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { gatewayName, localGatewayRuntime } from "../LocalGateway.ts";
import type { D1QueryResult, D1SqlExecutor } from "./ApplyMigrations.ts";

export { localGatewayRuntime as localD1GatewayRuntime };

export class LocalD1QueryError extends Data.TaggedError("LocalD1QueryError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * A single query or batch in the shape the cloud `d1.queryDatabase` op
 * accepts — the local gateway speaks the same surface so client code can
 * swap transports without translation.
 */
export type D1QueryBody =
  | { sql: string; params?: unknown[] }
  | { batch: Array<{ sql: string; params?: unknown[] }> };

interface D1StatementResponse {
  success: boolean;
  results?: unknown;
  meta?: unknown;
  error?: string;
}

/**
 * A plain service binding onto the raw `d1` service for `databaseId` —
 * bypassing the `cloudflare-internal:d1-api` wrapper so the proxy's fetch
 * passthrough can POST the full D1 HTTP protocol.
 */
const rawD1Binding = (databaseId: string): BindingHook =>
  Effect.succeed({
    name: "D1_RAW",
    service: {
      name: SERVICE_D1,
      props: { json: JSON.stringify({ databaseId }) },
    },
  });

/**
 * Boot a scoped platform proxy for `databaseId`, hand `use` a query
 * function that tunnels {@link D1QueryBody} requests into the local
 * simulator, and tear the instance down when `use` completes.
 */
export const withLocalD1Query = <A, E, R>(
  databaseId: string,
  use: (
    query: (body: D1QueryBody) => Effect.Effect<D1QueryResult, LocalD1QueryError>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* open({
        name: gatewayName("alchemy-d1-gateway", databaseId),
        bindings: [
          // The wrapped binding is unused by the gateway itself, but its
          // hook registers the database with the D1 plugin so the `d1`
          // service is emitted into this workerd config.
          D1.local({ binding: "DB", id: databaseId }),
          rawD1Binding(databaseId),
        ],
      });
      const raw = (proxy.env as Record<string, unknown>).D1_RAW as {
        fetch: (input: string, init?: RequestInit) => Promise<Response>;
      };

      const query = (body: D1QueryBody) =>
        Effect.tryPromise({
          try: async () => {
            const response = await raw.fetch("http://d1/query", {
              method: "POST",
              headers: { "content-type": "application/json" },
              // The DO accepts a single D1Query or an array (one
              // transaction) — a batch maps to the array form.
              body: JSON.stringify("batch" in body ? body.batch : body),
            });
            return (await response.json()) as unknown;
          },
          catch: (cause) =>
            new LocalD1QueryError({
              message: "Failed to reach the local D1 gateway",
              cause,
            }),
        }).pipe(
          Effect.flatMap((responseBody) => {
            // Protocol errors come back `{ success: false, error }` (a
            // single object); successes are one envelope per statement.
            const responses = (
              Array.isArray(responseBody) ? responseBody : [responseBody]
            ) as D1StatementResponse[];
            const failed = responses.find((r) => !r.success);
            if (failed) {
              return Effect.fail(
                new LocalD1QueryError({
                  message: failed.error ?? "Local D1 query failed",
                }),
              );
            }
            return Effect.succeed({
              result: responses.map((r) => ({
                results: r.results,
                success: true,
                meta: r.meta,
              })),
            } as D1QueryResult);
          }),
        );

      return yield* use(query);
    }),
  );

/**
 * Whether the simulator holds no user tables for `databaseId` — its data
 * was deleted (`.alchemy/local/d1` removed) or never written. Resource state
 * can outlive the simulator's storage, so the local provider observes this
 * instead of trusting the migration and import hashes it persisted.
 * Simulator-internal (`_cf_*`) and SQLite tables don't count.
 */
export const localD1IsEmpty = (databaseId: string) =>
  withLocalD1Query(databaseId, (query) =>
    query({
      sql:
        "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' " +
        "AND substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_'",
    }),
  ).pipe(
    // The gateway is a second workerd process over the same DO SQLite file
    // as the dev Workers. A read-only transaction there can start on a
    // snapshot another process has since written past, and the commit
    // token lookup then fails with SQLITE_BUSY_SNAPSHOT. A fresh gateway
    // reads the current snapshot.
    Effect.retry({ times: 5, schedule: Schedule.spaced("100 millis") }),
    Effect.map((response) => {
      const rows = response.result[0]?.results as Array<{ n: number }> | undefined;
      return (rows?.[0]?.n ?? 0) === 0;
    }),
  );

/**
 * SQL-only view of {@link withLocalD1Query} matching the migration flow's
 * {@link D1SqlExecutor} contract. Multi-statement SQL runs as a batch of its
 * statements, as the cloud query endpoint splits it: the simulator's SQLite
 * rejects one statement over its length limit.
 */
export const withLocalD1Executor = <A, E, R>(
  databaseId: string,
  use: (executor: D1SqlExecutor<LocalD1QueryError>) => Effect.Effect<A, E, R>,
) =>
  withLocalD1Query(databaseId, (query) =>
    use((sql) => {
      const statements = splitSqliteStatements(sql);
      return statements.length > 1
        ? query({ batch: statements.map((statement) => ({ sql: statement })) })
        : query({ sql });
    }),
  );
