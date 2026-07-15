import type * as runtime from "@cloudflare/workers-types";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import type { Database } from "./Database.ts";
import {
  type QueryDatabaseClient,
  PreparedStatement,
  QueryDatabase,
} from "./QueryDatabase.ts";

/**
 * Local implementation of the {@link QueryDatabase} binding — queries D1 over
 * the Cloudflare HTTP API using the **current credentials** instead of a native
 * Worker binding (`QueryDatabaseBinding`) or a scoped API token.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can talk to
 * a D1 database with the same `prepare`/`exec`/`batch` client you'd use inside a
 * Worker:
 *
 * @example Seeding a database from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const db = yield* Cloudflare.D1.QueryDatabase(database);
 *     return Effect.fn(function* () {
 *       yield* db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT, name TEXT)");
 *       yield* db
 *         .prepare("INSERT INTO users (id, name) VALUES (?, ?)")
 *         .bind("1", "Ada")
 *         .run();
 *     });
 *   }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
 * );
 * ```
 *
 * The database id is resolved at apply time through the ambient
 * {@link RuntimeContext} (in an Action, that's the resolve context the engine
 * provides around the body), so `QueryDatabase(database)` works even though the
 * database is created in the same deploy.
 */
export const QueryDatabaseLocal = Layer.effect(
  QueryDatabase,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the HTTP query effect can
    // be run from the Promise-based D1 shim below.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (database: Database) {
      // Deferred accessor — resolves the databaseId against the tracker at
      // apply time. No `host.bind`: the local variant registers no binding.
      const databaseId = yield* database.databaseId;

      const rawEff = Effect.map(databaseId, (id) =>
        makeHttpD1Database({ accountId, databaseId: id, context }),
      );

      return {
        raw: rawEff,
        prepare: (query: string) => new PreparedStatement(query, [], rawEff),
        exec: (query: string) =>
          Effect.flatMap(rawEff, (raw) =>
            Effect.promise(() => raw.exec(query)),
          ),
        batch: <T = unknown>(statements: PreparedStatement[]) =>
          Effect.flatMap(rawEff, (raw) =>
            Effect.promise(() =>
              raw.batch<T>(statements.map((s) => s._build(raw))),
            ),
          ),
      } satisfies QueryDatabaseClient;
    });
  }),
);

// ── HTTP-backed D1Database shim ──────────────────────────────────────────────
//
// PreparedStatement (shared with QueryDatabaseBinding) drives a
// `runtime.D1Database` whose executors return Promises. This shim implements the
// slice PreparedStatement uses (prepare/exec/batch + stmt bind/all/first/run/raw)
// by running `d1.queryDatabase` over HTTP with the captured credentials context.

interface QueryContext {
  accountId: string;
  databaseId: string;
  context: Context.Context<Credentials | HttpClient.HttpClient>;
}

const runQuery = (
  ctx: QueryContext,
  body:
    | { sql: string; params?: unknown[] }
    | { batch: { sql: string; params?: unknown[] }[] },
): Promise<d1.QueryDatabaseResponse> =>
  d1
    .queryDatabase({
      accountId: ctx.accountId,
      databaseId: ctx.databaseId,
      ...(body as any),
    })
    .pipe(Effect.provideContext(ctx.context), Effect.runPromise);

const toResult = <T>(
  r: d1.QueryDatabaseResponse["result"][number] | undefined,
): runtime.D1Result<T> =>
  ({
    results: (r?.results ?? []) as T[],
    success: r?.success ?? true,
    meta: (r?.meta ?? {}) as any,
  }) as runtime.D1Result<T>;

/**
 * Normalize a bound value the way the native D1 binding does before it reaches
 * SQLite. Over the raw HTTP query API, unlike the Worker binding, values are
 * bound verbatim — a JS `true` would arrive as the string `"true"`. Match the
 * native semantics: booleans become integers (1/0) and binary becomes a byte
 * array (BLOB). `null`, numbers, and strings pass through unchanged.
 */
const normalizeBind = (value: unknown): unknown => {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  return value;
};

const makeHttpD1Database = (ctx: QueryContext): runtime.D1Database => {
  const makeStatement = (
    query: string,
    binds: ReadonlyArray<unknown>,
  ): runtime.D1PreparedStatement => {
    const exec = async () => {
      const res = await runQuery(ctx, {
        sql: query,
        params: binds.length ? binds.map(normalizeBind) : undefined,
      });
      return res.result[0];
    };
    return {
      bind: (...values: unknown[]) => makeStatement(query, values),
      first: (async (column?: string) => {
        const first = (await exec())?.results?.[0] as
          | Record<string, unknown>
          | undefined;
        if (first == null) return null;
        return column !== undefined ? (first[column] ?? null) : first;
      }) as runtime.D1PreparedStatement["first"],
      all: (async () =>
        toResult(await exec())) as runtime.D1PreparedStatement["all"],
      run: (async () =>
        toResult(await exec())) as runtime.D1PreparedStatement["run"],
      raw: (async (options?: { columnNames?: boolean }) => {
        const rows = ((await exec())?.results ?? []) as Record<
          string,
          unknown
        >[];
        const arrays = rows.map((row) => Object.values(row));
        if (options?.columnNames && rows[0]) {
          return [Object.keys(rows[0]), ...arrays];
        }
        return arrays;
      }) as runtime.D1PreparedStatement["raw"],
      // Carry query + params so `batch` can reconstruct the request.
      __query: query,
      __params: binds,
    } as unknown as runtime.D1PreparedStatement;
  };

  return {
    prepare: (query: string) => makeStatement(query, []),
    exec: async (query: string) => {
      const res = await runQuery(ctx, { sql: query });
      const meta = res.result[res.result.length - 1]?.meta;
      return {
        count: res.result.length,
        duration: meta?.duration ?? 0,
      } as runtime.D1ExecResult;
    },
    batch: async <T = unknown>(statements: runtime.D1PreparedStatement[]) => {
      const res = await runQuery(ctx, {
        batch: statements.map((s) => ({
          sql: (s as any).__query as string,
          params: ((s as any).__params as unknown[]).length
            ? ((s as any).__params as unknown[]).map(normalizeBind)
            : undefined,
        })),
      });
      return res.result.map((r) => toResult<T>(r));
    },
  } as unknown as runtime.D1Database;
};
