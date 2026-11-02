import type * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ResetUserRequest extends Omit<
  mongodb.ResetUserRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for MongoDB Flex `resetUser`: reset a user's password and get the new one and its connection string, `Redacted`.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ResetUserHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mongodb-flex.user.reset`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MongoDB Flex instance in that project.
 *
 * ### Calling `resetUser`
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
 *     const resetUser = yield* Stackit.MongoDBFlex.ResetUser(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { username } = yield* resetUser({ userId: "user-id" });
 *         return yield* HttpServerResponse.json({ rotated: username });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.ResetUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface ResetUser extends Binding.Service<
  ResetUser,
  "Stackit.MongoDBFlex.ResetUser",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ResetUserRequest,
    ) => Effect.Effect<mongodb.User, mongodb.ResetUserError, RuntimeContext>
  >
> {}

export const ResetUser = Binding.Service<ResetUser>("Stackit.MongoDBFlex.ResetUser");
