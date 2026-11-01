import type * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUserRequest extends Omit<
  secretsManager.GetUserRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Secrets Manager `getUser`: read one user of an instance.
 * STACKIT returns its password only when it creates the user.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link GetUserHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates
 * for it. This goes through STACKIT's management API, so the instance's ACL
 * doesn't apply.
 *
 * Access: a custom role with `secrets-manager.instance.get`, the permission the
 * spec names for this operation, on the project holding the instance. STACKIT
 * binds roles on nothing narrower, so it reaches every instance in the project.
 *
 * ### Reading a User
 * **Example:** Read a user's access level from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Vault = Stackit.SecretsManager.Instance("Vault", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getUser = yield* Stackit.SecretsManager.GetUser(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const user = yield* getUser({ userId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ write: user.write });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.GetUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "Stackit.SecretsManager.GetUser",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetUserRequest,
    ) => Effect.Effect<secretsManager.User, secretsManager.GetUserError, RuntimeContext>
  >
> {}

export const GetUser = Binding.Service<GetUser>("Stackit.SecretsManager.GetUser");
