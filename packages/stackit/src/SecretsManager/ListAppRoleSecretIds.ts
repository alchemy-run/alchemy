import type * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAppRoleSecretIdsRequest extends Omit<
  secretsManager.ListApproleSecretIdsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Secrets Manager `listApproleSecretIds`: list an AppRole's
 * secret ids. This returns their metadata, never their values.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link ListAppRoleSecretIdsHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates
 * for it. This goes through STACKIT's management API, so the instance's ACL
 * doesn't apply.
 *
 * Access: a custom role with `secrets-manager.instance.get`, the permission the
 * spec names for this operation, on the project holding the instance. STACKIT
 * binds roles on nothing narrower, so it reaches every instance in the project.
 *
 * ### Listing Secret Ids
 * **Example:** Count an AppRole's secret ids from a Cloudflare Worker
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
 *     const listSecretIds = yield* Stackit.SecretsManager.ListAppRoleSecretIds(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { secretIds } = yield* listSecretIds({
 *           roleId: "00000000-0000-0000-0000-000000000000",
 *         });
 *         return yield* HttpServerResponse.json({ count: secretIds.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ListAppRoleSecretIdsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface ListAppRoleSecretIds extends Binding.Service<
  ListAppRoleSecretIds,
  "Stackit.SecretsManager.ListAppRoleSecretIds",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListAppRoleSecretIdsRequest,
    ) => Effect.Effect<
      secretsManager.ApproleSecretList,
      secretsManager.ListApproleSecretIdsError,
      RuntimeContext
    >
  >
> {}

export const ListAppRoleSecretIds = Binding.Service<ListAppRoleSecretIds>(
  "Stackit.SecretsManager.ListAppRoleSecretIds",
);
