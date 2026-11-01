import type * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListACLsRequest extends Omit<
  secretsManager.ListACLsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Secrets Manager `listACLs`: list the CIDR ranges allowed
 * to reach an instance's Vault API.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link ListACLsHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates
 * for it. This goes through STACKIT's management API, so the instance's ACL
 * doesn't apply.
 *
 * Access: a custom role with `secrets-manager.instance.get`, the permission the
 * spec names for this operation, on the project holding the instance. STACKIT
 * binds roles on nothing narrower, so it reaches every instance in the project.
 *
 * ### Listing ACLs
 * **Example:** List the ACL entries from a Cloudflare Worker
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
 *     const listAcls = yield* Stackit.SecretsManager.ListACLs(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { acls } = yield* listAcls({});
 *         return yield* HttpServerResponse.json({ ranges: acls.map((acl) => acl.cidr) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ListACLsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface ListACLs extends Binding.Service<
  ListACLs,
  "Stackit.SecretsManager.ListACLs",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListACLsRequest,
    ) => Effect.Effect<
      secretsManager.ListACLsResponse,
      secretsManager.ListACLsError,
      RuntimeContext
    >
  >
> {}

export const ListACLs = Binding.Service<ListACLs>("Stackit.SecretsManager.ListACLs");
