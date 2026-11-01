import type * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUsersRequest extends Omit<
  secretsManager.ListUsersRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Secrets Manager `listUsers`: list an instance's users.
 * STACKIT returns passwords only when it creates a user.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link ListUsersHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates
 * for it. This goes through STACKIT's management API, so the instance's ACL
 * doesn't apply.
 *
 * Access: a custom role with `secrets-manager.instance.get`, the permission the
 * spec names for this operation, on the project holding the instance. STACKIT
 * binds roles on nothing narrower, so it reaches every instance in the project.
 *
 * ### Listing Users
 * **Example:** Count the users from a Cloudflare Worker
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
 *     const listUsers = yield* Stackit.SecretsManager.ListUsers(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { users } = yield* listUsers({});
 *         return yield* HttpServerResponse.json({ count: users.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ListUsersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "Stackit.SecretsManager.ListUsers",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListUsersRequest,
    ) => Effect.Effect<
      secretsManager.ListUsersResponse,
      secretsManager.ListUsersError,
      RuntimeContext
    >
  >
> {}

export const ListUsers = Binding.Service<ListUsers>("Stackit.SecretsManager.ListUsers");
