import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

/** Every read and write operation on a bound instance. */
export interface ReadWriteInstanceClient extends ReadInstanceClient, WriteInstanceClient {}

/**
 * Read an {@link Instance}, rotate its passwords and start its backups and restores
 * from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadWriteInstanceHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the permissions of the read and write operations, bound on
 * the project holding the instance. STACKIT binds roles on projects at the narrowest, so
 * they reach every SQL Server Flex instance in that project.
 *
 * ### Reading and Backing Up
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const db = yield* Db;
 *     const client = yield* Stackit.SQLServerFlex.ReadWriteInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { databases } = yield* client.listDatabases();
 *         yield* client.triggerBackup({ databaseName: databases[0]!.name });
 *         return yield* HttpServerResponse.json({ started: databases[0]!.name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SQLServerFlex.ReadWriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SQLServerFlex
 */
export interface ReadWriteInstance extends Binding.Service<
  ReadWriteInstance,
  "Stackit.SQLServerFlex.ReadWriteInstance",
  (instance: Instance) => Effect.Effect<ReadWriteInstanceClient>
> {}

export const ReadWriteInstance = Binding.Service<ReadWriteInstance>(
  "Stackit.SQLServerFlex.ReadWriteInstance",
);
