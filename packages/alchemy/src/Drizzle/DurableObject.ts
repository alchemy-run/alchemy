import * as SqliteDoClient from "@effect/sql-sqlite-do/SqliteClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as SQLiteDoDrizzle from "drizzle-orm/effect-sqlite-do";
import { migrate } from "drizzle-orm/effect-sqlite-do/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DurableObjectState } from "../Cloudflare/Workers/DurableObjectState.ts";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

/**
 * Migrations for {@link DurableObject} — the shape of the `migrations.js`
 * bundle `drizzle-kit generate` emits for `driver: "durable-sqlite"`
 * (each migration's `.sql` file imported as a text module).
 */
export interface DurableObjectMigrations {
  readonly migrations: Record<string, string>;
  readonly migrationsTable?: string | undefined;
}

export interface DurableObjectConfig<
  TRelations extends AnyRelations = EmptyRelations,
> extends Omit<
  SQLiteDoDrizzle.EffectDrizzleSQLiteDoConfig<TRelations>,
  "storage"
> {
  /**
   * Migrations to apply before the first query — pass the default export
   * of drizzle-kit's generated `migrations.js` directly. Applied at most
   * once per instance; drizzle records applied migrations in the
   * database, so replays are cheap no-ops anyway.
   */
  readonly migrations?: DurableObjectMigrations | undefined;
}

/**
 * Instances whose migrations already ran in this isolate, keyed on the
 * raw `DurableObjectStorage`. Applied migrations are recorded in the
 * database itself, so this only skips the redundant re-check on
 * executions after the first.
 */
const migrated = new WeakSet<object>();

/**
 * Open a Drizzle database over the current Durable Object's SQLite
 * storage using the `drizzle-orm/effect-sqlite-do` integration (which
 * drives queries through `@effect/sql-sqlite-do`'s `SqliteClient`).
 *
 * Resolves `Cloudflare.DurableObjectState` from context and returns a
 * chainable Proxy over `EffectSQLiteDoDatabase` (via `proxyChain`): every
 * property read records a step, every call records args, and the chain is
 * replayed against the resolved drizzle db when it's finally yielded as
 * an Effect. Yield it in the object's outer Effect and query from any
 * method:
 *
 * ```typescript
 * import migrations from "./drizzle/migrations.js";
 *
 * export class Users extends Cloudflare.DurableObject<Users>()(
 *   "Users",
 *   Effect.gen(function* () {
 *     const db = yield* Drizzle.DurableObject({ migrations });
 *
 *     return Effect.gen(function* () {
 *       return {
 *         addUser: (name: string) => db.insert(users).values({ name }),
 *         listUsers: () => db.select().from(users),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * The client build is deferred until the first query and memoized on the
 * current execution's `Scope` (via {@link makeExecutionMemo}), so the
 * `SqliteClient` is built at most once per Durable Object call and reused
 * across every query in that call. Resolving the state is likewise
 * deferred, so deploy / plan-time evaluation (where the constructor runs
 * with a mock `DurableObjectState`) never touches storage.
 *
 * When `migrations` are provided they are applied before the first query
 * of the instance's first execution, so every method observes the
 * migrated schema.
 *
 * @binding
 */
export const DurableObject = <TRelations extends AnyRelations = EmptyRelations>(
  config?: DurableObjectConfig<TRelations>,
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const state = yield* DurableObjectState;
        const storage = state.raw.storage;
        const doCtx = yield* Layer.build(SqliteDoClient.layer({ storage }));
        const { migrations, ...drizzleConfig } = config ?? {};
        const db = yield* SQLiteDoDrizzle.makeWithDefaults({
          ...(drizzleConfig as Omit<
            SQLiteDoDrizzle.EffectDrizzleSQLiteDoConfig<TRelations>,
            "storage"
          >),
          storage,
        }).pipe(Effect.provideContext(doCtx));
        if (migrations !== undefined && !migrated.has(storage)) {
          yield* migrate(db, {
            migrations: migrations.migrations,
            ...(migrations.migrationsTable !== undefined
              ? { migrationsTable: migrations.migrationsTable }
              : {}),
          });
          migrated.add(storage);
        }
        return db;
      }),
    ),
    (db) =>
      proxyChain<
        EffectSQLiteDoDatabase<TRelations> & {
          $client: SqliteDoClient.SqliteClient;
        }
      >(
        db as Effect.Effect<
          EffectSQLiteDoDatabase<TRelations> & {
            $client: SqliteDoClient.SqliteClient;
          }
        >,
      ),
  );
