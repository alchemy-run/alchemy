import type * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CloneInstanceRequest extends Omit<
  mongodb.CloneInstanceRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for MongoDB Flex `cloneInstance`: apply the bound instance's backups, at a point in time, to an existing instance. The bound instance is the source and `targetInstanceId` the instance that gets the data, which can be the bound one.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CloneInstanceHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mongodb-flex.backup.clone`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MongoDB Flex instance in that project.
 *
 * ### Calling `cloneInstance`
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
 *     const cloneInstance = yield* Stackit.MongoDBFlex.CloneInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { instanceId } = yield* cloneInstance({
 *           targetInstanceId: "target-instance-id",
 *           timestamp: "2026-11-01T02:30:00Z",
 *         });
 *         return yield* HttpServerResponse.json({ instanceId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.CloneInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface CloneInstance extends Binding.Service<
  CloneInstance,
  "Stackit.MongoDBFlex.CloneInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CloneInstanceRequest,
    ) => Effect.Effect<mongodb.CloneInstanceResponse, mongodb.CloneInstanceError, RuntimeContext>
  >
> {}

export const CloneInstance = Binding.Service<CloneInstance>("Stackit.MongoDBFlex.CloneInstance");
