import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Database } from "./Database.ts";

export interface ExecuteSqlRequest extends spanner.ExecuteSqlRequest {}

export type ExecuteSqlError =
  | spanner.CreateProjectsInstancesDatabasesSessionsError
  | spanner.ExecuteSqlProjectsInstancesDatabasesSessionsError;

/**
 * Runtime binding for Spanner `sessions.executeSql`.
 *
 * Bind this operation to a {@link Database} in a Function/Action init
 * phase. Provide {@link ExecuteSqlHttp}. Statements run on one
 * multiplexed session per database, created on first use and reused for
 * the life of the runtime instance.
 *
 * ### Executing SQL
 * **Example:** Run a query
 * ```typescript
 * const executeSql = yield* GCP.Spanner.ExecuteSql(database);
 * const result = yield* executeSql({ sql: "SELECT 1 AS n" });
 * ```
 *
 * @binding
 * @category Spanner
 */
export interface ExecuteSql extends Binding.Service<
  ExecuteSql,
  "GCP.Spanner.ExecuteSql",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: ExecuteSqlRequest,
    ) => Effect.Effect<spanner.ResultSet, ExecuteSqlError, RuntimeContext>
  >
> {}

export const ExecuteSql = Binding.Service<ExecuteSql>("GCP.Spanner.ExecuteSql");

/**
 * HTTP implementation of {@link ExecuteSql}.
 *
 * Reuses one multiplexed session per database for the life of the runtime
 * instance (multiplexed sessions serve concurrent requests and are never
 * deleted by the client). A session the server has dropped
 * (`SessionNotFound`) is replaced once and the statement retried.
 *
 * @layer
 * @provides GCP.Spanner.ExecuteSql
 */
export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const createSession = yield* GCPBindings.withCredentials(
      spanner.createProjectsInstancesDatabasesSessions,
    );
    const executeSql = yield* GCPBindings.withCredentials(
      spanner.executeSqlProjectsInstancesDatabasesSessions,
    );
    // Session names by database name; plain values, safe to keep per instance.
    const sessions = new Map<string, string>();
    const lock = yield* Semaphore.make(1);

    const sessionFor = (database: string, stale?: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const cached = sessions.get(database);
          if (cached !== undefined && cached !== stale) return cached;
          const session = yield* createSession({
            database,
            body: { session: { multiplexed: true } },
          });
          const name = session.name ?? "";
          sessions.set(database, name);
          return name;
        }),
      );

    return Effect.fn(function* (database: Database) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Spanner.ExecuteSql(${database})`({
          iam: [
            grantFor({ role: "roles/spanner.databaseUser", on: "spanner.database" }, database.name),
          ],
        });
      }
      const name = yield* database.name;
      return Effect.fn(`GCP.Spanner.ExecuteSql(${database.LogicalId})`)(function* (
        request: ExecuteSqlRequest,
      ) {
        const databaseName = yield* name;
        const session = yield* sessionFor(databaseName);
        return yield* executeSql({ session, body: request }).pipe(
          Effect.catchTag("SessionNotFound", () =>
            Effect.gen(function* () {
              const fresh = yield* sessionFor(databaseName, session);
              return yield* executeSql({ session: fresh, body: request });
            }),
          ),
        );
      });
    });
  }),
);
