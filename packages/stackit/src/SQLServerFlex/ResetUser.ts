import type * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ResetUserRequest extends Omit<
  sqlserver.ResetUserRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for SQL Server Flex `resetUser`: reset a user's password and get the new one and its connection string, `Redacted`.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ResetUserHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Whoever holds the old password is locked out, and the stack's `User` keeps the old
 * one: use `rotationKey` on the resource when the stack hands out the password.
 *
 * Access: a custom role with the single permission `sqlserver-flex.user.reset`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every SQL Server Flex instance in that project.
 *
 * ### Calling `resetUser`
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
 *     const resetUser = yield* Stackit.SQLServerFlex.ResetUser(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { username } = yield* resetUser({ userId: 1 });
 *         return yield* HttpServerResponse.json({ rotated: username });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SQLServerFlex.ResetUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SQLServerFlex
 */
export interface ResetUser extends Binding.Service<
  ResetUser,
  "Stackit.SQLServerFlex.ResetUser",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ResetUserRequest,
    ) => Effect.Effect<sqlserver.ResetUserResponse, sqlserver.ResetUserError, RuntimeContext>
  >
> {}

export const ResetUser = Binding.Service<ResetUser>("Stackit.SQLServerFlex.ResetUser");
