import type * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";
import type { ResetUserPasswordRequest } from "./ResetUserPassword.ts";

/** The write operations on a bound instance. Its project, region and id are injected. */
export interface WriteInstanceClient {
  /** Reset a user's password and get the new one, `Redacted`. */
  resetUserPassword(
    request: ResetUserPasswordRequest,
  ): Effect.Effect<
    postgres.ResetUserPasswordResponse,
    postgres.ResetUserPasswordError,
    RuntimeContext
  >;
}

/**
 * Change an {@link Instance}'s users from a Function/Worker. Password rotation is the
 * only change a runtime gets: settings, users and databases belong to the stack.
 *
 * Bind it in the init phase and provide {@link WriteInstanceHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role with the permission `postgres-flex.user.reset`, bound on the
 * project holding the instance. STACKIT binds roles on projects at the narrowest, so it
 * reaches every PostgreSQL Flex instance in that project.
 *
 * ### Rotating a Password
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
 *     const client = yield* Stackit.PostgresFlex.WriteInstance(db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { name } = yield* client.resetUserPassword({ userId: 1 });
 *         return yield* HttpServerResponse.json({ rotated: name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PostgresFlex.WriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PostgresFlex
 */
export interface WriteInstance extends Binding.Service<
  WriteInstance,
  "Stackit.PostgresFlex.WriteInstance",
  (instance: Instance) => Effect.Effect<WriteInstanceClient>
> {}

export const WriteInstance = Binding.Service<WriteInstance>("Stackit.PostgresFlex.WriteInstance");
