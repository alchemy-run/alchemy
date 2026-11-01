import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

/** Every read and write operation on a bound instance. */
export interface ReadWriteInstanceClient extends ReadInstanceClient, WriteInstanceClient {}

/**
 * Read an {@link Instance}, rotate its users' passwords and restore its backups from a
 * Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadWriteInstanceHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the permissions of the read and write operations, bound on
 * the project holding the instance. STACKIT binds roles on projects at the narrowest, so
 * they reach every MongoDB Flex instance in that project.
 *
 * ### Reading and Rotating
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const db = yield* Db;
 *     const client = yield* Stackit.MongoDBFlex.ReadWriteInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* client.getUser({ userId: "user-id" });
 *         const { username } = yield* client.resetUser({ userId: "user-id" });
 *         return yield* HttpServerResponse.json({ read: live.item?.username, rotated: username });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.ReadWriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface ReadWriteInstance extends Binding.Service<
  ReadWriteInstance,
  "Stackit.MongoDBFlex.ReadWriteInstance",
  (instance: Instance) => Effect.Effect<ReadWriteInstanceClient>
> {}

export const ReadWriteInstance = Binding.Service<ReadWriteInstance>(
  "Stackit.MongoDBFlex.ReadWriteInstance",
);
