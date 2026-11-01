import type * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CloneInstanceRequest } from "./CloneInstance.ts";
import type { Instance } from "./Instance.ts";
import type { ResetUserRequest } from "./ResetUser.ts";
import type { RestoreInstanceRequest } from "./RestoreInstance.ts";

/** The write operations on a bound instance. Its project, region and id are injected. */
export interface WriteInstanceClient {
  /** Reset a user's password and get the new one and its connection string, `Redacted`. */
  resetUser(
    request: ResetUserRequest,
  ): Effect.Effect<mongodb.User, mongodb.ResetUserError, RuntimeContext>;
  /** Apply the bound instance's backups, at a point in time, to `targetInstanceId`. */
  cloneInstance(
    request: CloneInstanceRequest,
  ): Effect.Effect<mongodb.CloneInstanceResponse, mongodb.CloneInstanceError, RuntimeContext>;
  /** Restore one of the bound instance's backups onto `targetInstanceId`. */
  restoreInstance(
    request: RestoreInstanceRequest,
  ): Effect.Effect<mongodb.RestoreInstanceResponse, mongodb.RestoreInstanceError, RuntimeContext>;
}

/**
 * Rotate an {@link Instance}'s user passwords and restore its backups from a
 * Function/Worker. Settings and users belong to the stack.
 *
 * Bind it in the init phase and provide {@link WriteInstanceHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the permissions `mongodb-flex.user.reset`,
 * `mongodb-flex.backup.clone` and `mongodb-flex.backup.restore-snapshot`, bound on the
 * project holding the instance. STACKIT binds roles on projects at the narrowest, so they
 * reach every MongoDB Flex instance in that project.
 *
 * ### Rotating a Password
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
 *     const client = yield* Stackit.MongoDBFlex.WriteInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { username } = yield* client.resetUser({ userId: "user-id" });
 *         return yield* HttpServerResponse.json({ rotated: username });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.WriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface WriteInstance extends Binding.Service<
  WriteInstance,
  "Stackit.MongoDBFlex.WriteInstance",
  (instance: Instance) => Effect.Effect<WriteInstanceClient>
> {}

export const WriteInstance = Binding.Service<WriteInstance>("Stackit.MongoDBFlex.WriteInstance");
