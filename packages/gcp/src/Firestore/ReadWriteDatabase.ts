import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Database } from "./Database.ts";
import { makeFirestoreDatabaseBinding, readWriteDatabaseIam } from "./DatabaseHttp.ts";
import type { ReadDatabaseClient } from "./ReadDatabase.ts";
import type { WriteDatabaseClient } from "./WriteDatabase.ts";

export interface ReadWriteDatabaseClient extends ReadDatabaseClient, WriteDatabaseClient {}

/**
 * Read and write access to a Firestore {@link Database}. Grants
 * `roles/datastore.user` on the project under an IAM Condition naming
 * this database (Firestore databases have no resource-level IAM policy).
 *
 * ### Reading and writing
 * **Example:** Increment a counter
 * ```typescript
 * const db = yield* GCP.Firestore.ReadWriteDatabase(database);
 * const doc = yield* db.get("counters/visits");
 * const count = typeof doc?.fields.count === "number" ? doc.fields.count : 0;
 * yield* db.set("counters/visits", { count: count + 1 });
 * // …provided with Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp)
 * ```
 *
 * @binding
 * @category Firestore
 */
export interface ReadWriteDatabase extends Binding.Service<
  ReadWriteDatabase,
  "GCP.Firestore.ReadWriteDatabase",
  (database: Database) => Effect.Effect<ReadWriteDatabaseClient>
> {}

export const ReadWriteDatabase = Binding.Service<ReadWriteDatabase>(
  "GCP.Firestore.ReadWriteDatabase",
);

/**
 * HTTP implementation of {@link ReadWriteDatabase} over the Firestore REST API.
 *
 * @layer
 * @provides GCP.Firestore.ReadWriteDatabase
 * @category Firestore
 */
export const ReadWriteDatabaseHttp = Layer.effect(
  ReadWriteDatabase,
  makeFirestoreDatabaseBinding({
    tag: "GCP.Firestore.ReadWriteDatabase",
    iam: readWriteDatabaseIam,
    makeClient: (helpers, name) => ({
      ...helpers.makeRead(name),
      ...helpers.makeWrite(name),
    }),
  }),
);
