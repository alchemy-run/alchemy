import type * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ResetUserPasswordRequest extends Omit<
  postgres.ResetUserPasswordRequest,
  "projectId" | "region" | "instanceId"
> {}

/**
 * Runtime binding for PostgreSQL Flex `resetUserPassword`: reset a user's password and get the new one, `Redacted`.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ResetUserPasswordHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `postgres-flex.user.reset`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every PostgreSQL Flex instance in that project.
 *
 * ### Calling `resetUserPassword`
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
 *     const resetUserPassword = yield* Stackit.PostgresFlex.ResetUserPassword(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { name } = yield* resetUserPassword({ userId: 1 });
 *         return yield* HttpServerResponse.json({ rotated: name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PostgresFlex.ResetUserPasswordHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PostgresFlex
 */
export interface ResetUserPassword extends Binding.Service<
  ResetUserPassword,
  "Stackit.PostgresFlex.ResetUserPassword",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ResetUserPasswordRequest,
    ) => Effect.Effect<
      postgres.ResetUserPasswordResponse,
      postgres.ResetUserPasswordError,
      RuntimeContext
    >
  >
> {}

export const ResetUserPassword = Binding.Service<ResetUserPassword>(
  "Stackit.PostgresFlex.ResetUserPassword",
);
