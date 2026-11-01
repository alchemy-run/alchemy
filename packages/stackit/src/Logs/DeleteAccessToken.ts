import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteAccessTokenRequest extends Omit<
  logs.DeleteAccessTokenRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for Logs `deleteAccessToken`: revoke a token by its id. Use it on
 * tokens the host minted with `Stackit.Logs.CreateAccessToken`: deleting a
 * `Stackit.Logs.AccessToken` here makes the next deploy create a new one.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteAccessTokenHttp}. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: a custom role holding only `logs.instance.credentials.delete`, on the
 * project holding the instance. STACKIT binds roles on projects, folders and
 * organizations, never on one instance, so the role reaches every Logs instance in the
 * project. The deployer needs `iam.role.add` on the project to define it.
 *
 * ### Revoking a Token
 * **Example:** Revoke a token from a Cloudflare Worker
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
 *     const deleteAccessToken = yield* Stackit.Logs.DeleteAccessToken(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* deleteAccessToken({ tId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ revoked: true, result });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.DeleteAccessTokenHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface DeleteAccessToken extends Binding.Service<
  DeleteAccessToken,
  "Stackit.Logs.DeleteAccessToken",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteAccessTokenRequest,
    ) => Effect.Effect<logs.DeleteAccessTokenResponse, logs.DeleteAccessTokenError, RuntimeContext>
  >
> {}

export const DeleteAccessToken = Binding.Service<DeleteAccessToken>(
  "Stackit.Logs.DeleteAccessToken",
);
