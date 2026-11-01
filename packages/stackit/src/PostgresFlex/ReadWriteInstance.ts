import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

/** Every read and write operation on a bound instance. */
export interface ReadWriteInstanceClient extends ReadInstanceClient, WriteInstanceClient {}

/**
 * Read an {@link Instance} and rotate its users' passwords from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadWriteInstanceHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the permissions of the read operations and
 * `postgres-flex.user.reset`, bound on the project holding the instance. STACKIT binds
 * roles on projects at the narrowest, so they reach every PostgreSQL Flex instance in
 * that project.
 *
 * ### Reading and Rotating
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
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
 *     const client = yield* Stackit.PostgresFlex.ReadWriteInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { users } = yield* client.listUsers();
 *         const { name } = yield* client.resetUserPassword({ userId: users[0]!.id });
 *         return yield* HttpServerResponse.json({ rotated: name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PostgresFlex.ReadWriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PostgresFlex
 */
export interface ReadWriteInstance extends Binding.Service<
  ReadWriteInstance,
  "Stackit.PostgresFlex.ReadWriteInstance",
  (instance: Instance) => Effect.Effect<ReadWriteInstanceClient>
> {}

export const ReadWriteInstance = Binding.Service<ReadWriteInstance>(
  "Stackit.PostgresFlex.ReadWriteInstance",
);
