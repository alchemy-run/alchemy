import type * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUserRequest extends Omit<
  sqlserver.GetUserRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for SQL Server Flex `getUser`: read one user on an instance by id, without its password.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetUserHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `sqlserver-flex.user.get`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every SQL Server Flex instance in that project.
 *
 * ### Calling `getUser`
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
 *     const getUser = yield* Stackit.SQLServerFlex.GetUser(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getUser({ userId: 1 });
 *         return yield* HttpServerResponse.json({ roles: live.roles });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SQLServerFlex.GetUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SQLServerFlex
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "Stackit.SQLServerFlex.GetUser",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetUserRequest,
    ) => Effect.Effect<sqlserver.GetUserResponse, sqlserver.GetUserError, RuntimeContext>
  >
> {}

export const GetUser = Binding.Service<GetUser>("Stackit.SQLServerFlex.GetUser");
