import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteExpiredAccessTokensRequest extends Omit<
  logs.DeleteAllExpiredAccessTokensRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for Logs `deleteAllExpiredAccessTokens`: delete every expired token
 * on the instance, for a janitor job. It reaches every expired token on the instance,
 * including any another stack created.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteExpiredAccessTokensHttp}. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `logs.instance.credentials.delete`, on the
 * project holding the instance. STACKIT binds roles on projects, folders and
 * organizations, never on one instance, so the role reaches every Logs instance in the
 * project. The deployer needs `iam.role.add` on the project to define it.
 *
 * ### Cleaning Up Expired Tokens
 * **Example:** Delete expired tokens from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const deleteExpiredAccessTokens = yield* Stackit.Logs.DeleteExpiredAccessTokens(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* deleteExpiredAccessTokens({});
 *         return yield* HttpServerResponse.json({ deleted: result.tokens.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.DeleteExpiredAccessTokensHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface DeleteExpiredAccessTokens extends Binding.Service<
  DeleteExpiredAccessTokens,
  "Stackit.Logs.DeleteExpiredAccessTokens",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: DeleteExpiredAccessTokensRequest,
    ) => Effect.Effect<logs.AccessTokenList, logs.DeleteAllExpiredAccessTokensError, RuntimeContext>
  >
> {}

export const DeleteExpiredAccessTokens = Binding.Service<DeleteExpiredAccessTokens>(
  "Stackit.Logs.DeleteExpiredAccessTokens",
);
