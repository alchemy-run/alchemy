import type * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface RestoreInstanceRequest extends Omit<
  mongodb.RestoreInstanceRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for MongoDB Flex `restoreInstance`: restore one of the bound instance's backups onto an instance. The bound instance holds the backup and `targetInstanceId` is the instance that gets the data, which can be the bound one.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link RestoreInstanceHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mongodb-flex.backup.restore-snapshot`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MongoDB Flex instance in that project.
 *
 * ### Calling `restoreInstance`
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
 *     const restoreInstance = yield* Stackit.MongoDBFlex.RestoreInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { item } = yield* restoreInstance({
 *           backupId: "backup-id",
 *           targetInstanceId: "target-instance-id",
 *         });
 *         return yield* HttpServerResponse.json({ status: item?.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.RestoreInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface RestoreInstance extends Binding.Service<
  RestoreInstance,
  "Stackit.MongoDBFlex.RestoreInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: RestoreInstanceRequest,
    ) => Effect.Effect<
      mongodb.RestoreInstanceResponse,
      mongodb.RestoreInstanceError,
      RuntimeContext
    >
  >
> {}

export const RestoreInstance = Binding.Service<RestoreInstance>(
  "Stackit.MongoDBFlex.RestoreInstance",
);
