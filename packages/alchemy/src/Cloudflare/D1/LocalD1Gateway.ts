/**
 * Node-side query path into the local workerd D1 simulator.
 *
 * The simulator (a `d1` service routing to a per-database
 * `D1DatabaseObject` Durable Object over DO SQLite) is only reachable from
 * inside workerd — but alchemy's migration runner is Node code running in
 * the deploy process. This module bridges the two by booting a scoped,
 * ephemeral workerd instance whose only job is to forward HTTP requests to
 * the raw `d1` service:
 *
 *   Node ── POST {sql} ──▶ gateway worker ──▶ `d1` service ──▶ D1DatabaseObject
 *
 * The gateway binds the `d1` service directly (a plain service binding with
 * the database id on the designator props — the same designator the
 * `cloudflare-internal:d1-api` wrapped binding targets), so Node speaks the
 * full D1 HTTP protocol (`POST /query`, multi-statement SQL) rather than
 * the line-based `exec()` surface of the wrapped binding. Data lands in the
 * same `{storage}/d1` directory every local worker binding reads.
 *
 * The instance lives for the duration of one `use` callback and dies with
 * the scope — it exists only while the D1 local provider applies
 * migrations.
 *
 * NOT exported from `index.ts` — provider-internal scaffolding.
 */
import { layerRuntime, Runtime } from "@distilled.cloud/cloudflare-runtime";
import { D1 } from "@distilled.cloud/cloudflare-runtime/bindings";
import { SERVICE_D1 } from "@distilled.cloud/cloudflare-runtime/bindings/d1/D1Options";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { D1QueryResult, D1SqlExecutor } from "./ApplyMigrations.ts";

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

/**
 * The gateway worker: forwards the request body to the raw `d1` service.
 * The `D1DatabaseObject` behind it answers `POST /query` with the D1 HTTP
 * protocol (an array of `{ success, results, meta }` per statement batch).
 */
const GATEWAY_MODULE = `export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    return env.D1_RAW.fetch("http://d1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
    });
  },
};`;

interface D1StatementResponse {
  success: boolean;
  results?: unknown;
  meta?: unknown;
  error?: string;
}

/**
 * Boot an ephemeral gateway workerd for `databaseId`, hand `use` a query
 * function that tunnels {@link D1QueryBody} requests into the local
 * simulator, and tear the instance down when `use` completes.
 */
export const withLocalD1Query = <A, E, R>(
  databaseId: string,
  use: (
    query: (
      body: D1QueryBody,
    ) => Effect.Effect<D1QueryResult, LocalD1QueryError>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* Runtime;
      const client = yield* HttpClient.HttpClient;
      const url = yield* runtime.start({
        name: `alchemy-d1-gateway-${databaseId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        compatibilityDate: "2025-01-01",
        compatibilityFlags: [],
        modules: [
          { name: "gateway.js", type: "ESModule", content: GATEWAY_MODULE },
        ],
        // The wrapped binding is unused by the gateway itself, but its hook
        // registers the database with the D1 plugin so the `d1` service is
        // emitted into this workerd config.
        bindings: [D1.local({ binding: "DB", id: databaseId })],
        cache: false,
        unsafe: {
          bindings: [
            {
              name: "D1_RAW",
              service: {
                name: SERVICE_D1,
                props: { json: JSON.stringify({ databaseId }) },
              },
            },
          ],
        },
      });

      const query = (body: D1QueryBody) =>
        client
          .execute(
            HttpClientRequest.post(url.toString()).pipe(
              // The DO accepts a single D1Query or an array (one
              // transaction) — a batch maps to the array form.
              HttpClientRequest.bodyJsonUnsafe(
                "batch" in body ? body.batch : body,
              ),
            ),
          )
          .pipe(
            Effect.flatMap((res) => res.json),
            Effect.mapError(
              (cause) =>
                new LocalD1QueryError({
                  message: "Failed to reach the local D1 gateway",
                  cause,
                }),
            ),
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
 * SQL-only view of {@link withLocalD1Query} matching the migration flow's
 * {@link D1SqlExecutor} contract.
 */
export const withLocalD1Executor = <A, E, R>(
  databaseId: string,
  use: (executor: D1SqlExecutor<LocalD1QueryError>) => Effect.Effect<A, E, R>,
) => withLocalD1Query(databaseId, (query) => use((sql) => query({ sql })));

/**
 * A standalone local-runtime layer for gateway consumers OUTSIDE the
 * provider stack (e.g. `QueryDatabaseLocal` running in an Action, whose
 * ambient context has no workerd `Runtime`). Configured identically to the
 * providers' shared runtime — same `.alchemy/local` storage directory — so
 * it reads and writes the same simulator data.
 */
export const localD1GatewayRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const getEnv = yield* CloudflareEnvironment;
    const { dotAlchemy } = yield* AlchemyContext;
    const path = yield* Path.Path;
    return layerRuntime({
      api: {
        accountId: getEnv.pipe(Effect.map((env) => env.accountId)),
      },
      storage: {
        directory: path.join(dotAlchemy, "local"),
      },
    });
  }),
);
