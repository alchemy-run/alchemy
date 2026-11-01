import type * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUsersRequest extends Omit<
  mongodb.ListUsersRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for MongoDB Flex `listUsers`: list the users on the instance: their ids and names.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListUsersHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mongodb-flex.user.list`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MongoDB Flex instance in that project.
 *
 * ### Calling `listUsers`
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
 *     const listUsers = yield* Stackit.MongoDBFlex.ListUsers(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listUsers({});
 *         return yield* HttpServerResponse.json({ count: items?.length ?? 0 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.ListUsersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "Stackit.MongoDBFlex.ListUsers",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListUsersRequest,
    ) => Effect.Effect<mongodb.ListUsersResponse, mongodb.ListUsersError, RuntimeContext>
  >
> {}

export const ListUsers = Binding.Service<ListUsers>("Stackit.MongoDBFlex.ListUsers");
