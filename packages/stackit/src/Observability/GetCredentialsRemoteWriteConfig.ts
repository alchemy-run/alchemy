import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface GetCredentialsRemoteWriteConfigRequest extends Omit<
  observability.GetCredentialsRemoteWriteConfigRequest,
  "projectId" | "instanceId" | "username"
> {}

/**
 * Runtime binding for Observability `getCredentialsRemoteWriteConfig`: read a
 * credential's remote-write limit.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link GetCredentialsRemoteWriteConfigHttp}. The credential's project,
 * instance and username are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Reading a Remote-Write Limit
 * **Example:** Read the limit from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 * export const Tenant = Metrics.pipe(
 *   Effect.flatMap((metrics) =>
 *     Stackit.Observability.Credential("Tenant", { instanceId: metrics.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const tenant = yield* Tenant;
 *     const getCredentialsRemoteWriteConfig =
 *       yield* Stackit.Observability.GetCredentialsRemoteWriteConfig(tenant);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getCredentialsRemoteWriteConfig();
 *         return yield* HttpServerResponse.json({ maxLimit: live.maxLimit });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetCredentialsRemoteWriteConfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetCredentialsRemoteWriteConfig extends Binding.Service<
  GetCredentialsRemoteWriteConfig,
  "Stackit.Observability.GetCredentialsRemoteWriteConfig",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request?: GetCredentialsRemoteWriteConfigRequest,
    ) => Effect.Effect<
      observability.CredentialsRemoteWriteConfig,
      observability.GetCredentialsRemoteWriteConfigError,
      RuntimeContext
    >
  >
> {}

export const GetCredentialsRemoteWriteConfig = Binding.Service<GetCredentialsRemoteWriteConfig>(
  "Stackit.Observability.GetCredentialsRemoteWriteConfig",
);
