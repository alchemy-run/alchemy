import { storageBinding } from "../KV/StorageBinding.ts";
import type * as runtime from "./Native.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker } from "../Worker.ts";
import { WorkerEnvironment } from "../../Workers/Worker.ts";
import type { Database } from "./Database.ts";
import { makeQueryDatabaseClient, QueryDatabase } from "./QueryDatabase.ts";

/**
 * Register a same-fleet D1 binding and resolve its native client per invocation.
 *
 * @layer
 * @provides Celld.D1.QueryDatabase
 * @product Celld
 */
export const QueryDatabaseBinding = Layer.effect(
  QueryDatabase,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (database: Database) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${database}`({
          storageBindings: [storageBinding(database)],
          bindings: [
            {
              type: "d1",
              name: database.LogicalId,
              id: database.databaseId,
            },
          ],
        });
      }

      const rawEff = Effect.sync(
        () => (env as Record<string, runtime.D1Database>)[database.LogicalId]!,
      );

      return makeQueryDatabaseClient(rawEff);
    });
  }),
);
