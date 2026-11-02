import type * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  secretsManager.GetInstanceRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Secrets Manager `getInstance`: read an instance's name,
 * state, Vault URL and secret count.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link GetInstanceHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates
 * for it. This goes through STACKIT's management API, so the instance's ACL
 * doesn't apply.
 *
 * Access: a custom role with `secrets-manager.instance.get`, the permission the
 * spec names for this operation, on the project holding the instance. STACKIT
 * binds roles on nothing narrower, so it reaches every instance in the project.
 *
 * ### Reading the Instance
 * **Example:** Read the instance from a Cloudflare Worker
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
 *     const getInstance = yield* Stackit.SecretsManager.GetInstance(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getInstance({});
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.SecretsManager.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetInstanceRequest,
    ) => Effect.Effect<secretsManager.Instance, secretsManager.GetInstanceError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.SecretsManager.GetInstance");
