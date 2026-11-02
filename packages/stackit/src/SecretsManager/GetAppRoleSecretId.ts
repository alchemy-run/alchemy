import type * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetAppRoleSecretIdRequest extends Omit<
  secretsManager.GetApproleSecretIdRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Secrets Manager `getApproleSecretId`: read one secret
 * id's metadata. STACKIT returns the value only when it creates one.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link GetAppRoleSecretIdHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates
 * for it. This goes through STACKIT's management API, so the instance's ACL
 * doesn't apply.
 *
 * Access: a custom role with `secrets-manager.instance.get`, the permission the
 * spec names for this operation, on the project holding the instance. STACKIT
 * binds roles on nothing narrower, so it reaches every instance in the project.
 *
 * ### Reading a Secret Id
 * **Example:** Read a secret id's lifetime from a Cloudflare Worker
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
 *     const getSecretId = yield* Stackit.SecretsManager.GetAppRoleSecretId(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const secretId = yield* getSecretId({
 *           roleId: "00000000-0000-0000-0000-000000000000",
 *           secretIdVersion: 1,
 *         });
 *         return yield* HttpServerResponse.json({ ttl: secretId.ttl });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.GetAppRoleSecretIdHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface GetAppRoleSecretId extends Binding.Service<
  GetAppRoleSecretId,
  "Stackit.SecretsManager.GetAppRoleSecretId",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetAppRoleSecretIdRequest,
    ) => Effect.Effect<
      secretsManager.ApproleSecret,
      secretsManager.GetApproleSecretIdError,
      RuntimeContext
    >
  >
> {}

export const GetAppRoleSecretId = Binding.Service<GetAppRoleSecretId>(
  "Stackit.SecretsManager.GetAppRoleSecretId",
);
