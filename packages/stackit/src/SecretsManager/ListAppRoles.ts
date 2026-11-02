import type * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAppRolesRequest extends Omit<
  secretsManager.ListApprolesRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Secrets Manager `listApproles`: list an instance's
 * AppRoles.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link ListAppRolesHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates
 * for it. This goes through STACKIT's management API, so the instance's ACL
 * doesn't apply.
 *
 * Access: a custom role with `secrets-manager.instance.get`, the permission the
 * spec names for this operation, on the project holding the instance. STACKIT
 * binds roles on nothing narrower, so it reaches every instance in the project.
 *
 * ### Listing AppRoles
 * **Example:** List the role ids from a Cloudflare Worker
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
 *     const listAppRoles = yield* Stackit.SecretsManager.ListAppRoles(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { approles } = yield* listAppRoles({});
 *         return yield* HttpServerResponse.json({ roles: approles.map((role) => role.role_id) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ListAppRolesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface ListAppRoles extends Binding.Service<
  ListAppRoles,
  "Stackit.SecretsManager.ListAppRoles",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListAppRolesRequest,
    ) => Effect.Effect<secretsManager.ApproleList, secretsManager.ListApprolesError, RuntimeContext>
  >
> {}

export const ListAppRoles = Binding.Service<ListAppRoles>("Stackit.SecretsManager.ListAppRoles");
