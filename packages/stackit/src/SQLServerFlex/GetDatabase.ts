import type * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDatabaseRequest extends Omit<
  sqlserver.GetDatabaseRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for SQL Server Flex `getDatabase`: read one database on an instance by name.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetDatabaseHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `sqlserver-flex.database.get`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every SQL Server Flex instance in that project.
 *
 * ### Calling `getDatabase`
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
 *     const getDatabase = yield* Stackit.SQLServerFlex.GetDatabase(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getDatabase({ databaseName: "orders" });
 *         return yield* HttpServerResponse.json({ owner: live.owner });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SQLServerFlex.GetDatabaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SQLServerFlex
 */
export interface GetDatabase extends Binding.Service<
  GetDatabase,
  "Stackit.SQLServerFlex.GetDatabase",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDatabaseRequest,
    ) => Effect.Effect<sqlserver.GetDatabaseResponse, sqlserver.GetDatabaseError, RuntimeContext>
  >
> {}

export const GetDatabase = Binding.Service<GetDatabase>("Stackit.SQLServerFlex.GetDatabase");
