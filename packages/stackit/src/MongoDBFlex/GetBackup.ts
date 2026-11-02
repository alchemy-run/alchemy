import type * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetBackupRequest extends Omit<
  mongodb.GetBackupRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for MongoDB Flex `getBackup`: read one of the instance's backups by id.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetBackupHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mongodb-flex.backup.get`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MongoDB Flex instance in that project.
 *
 * ### Calling `getBackup`
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
 *     const getBackup = yield* Stackit.MongoDBFlex.GetBackup(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { item } = yield* getBackup({ backupId: "backup-id" });
 *         return yield* HttpServerResponse.json({ size: item?.size });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MongoDBFlex.GetBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MongoDBFlex
 */
export interface GetBackup extends Binding.Service<
  GetBackup,
  "Stackit.MongoDBFlex.GetBackup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetBackupRequest,
    ) => Effect.Effect<mongodb.GetBackupResponse, mongodb.GetBackupError, RuntimeContext>
  >
> {}

export const GetBackup = Binding.Service<GetBackup>("Stackit.MongoDBFlex.GetBackup");
