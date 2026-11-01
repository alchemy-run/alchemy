import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

export interface UpdateCredentialsRemoteWriteConfigRequest extends Omit<
  observability.UpdateCredentialsRemoteWriteConfigRequest,
  "projectId" | "instanceId" | "username"
> {}

/**
 * Runtime binding for Observability `updateCredentialsRemoteWriteConfig`: change a
 * credential's remote-write limit.
 *
 * Bind this operation to a {@link Credential} in a Function/Worker init phase and
 * provide {@link UpdateCredentialsRemoteWriteConfigHttp}. The credential's project,
 * instance and username are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If a `Credential` resource declares `remoteWriteLimit`, its next reconcile
 * overwrites what this binding changed.
 *
 * ### Throttling a Tenant
 * **Example:** Lower the limit from a Cloudflare Worker
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
 *     const updateCredentialsRemoteWriteConfig =
 *       yield* Stackit.Observability.UpdateCredentialsRemoteWriteConfig(tenant);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateCredentialsRemoteWriteConfig({ maxLimit: 1000 });
 *         return yield* HttpServerResponse.json({ maxLimit: live.maxLimit });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.UpdateCredentialsRemoteWriteConfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface UpdateCredentialsRemoteWriteConfig extends Binding.Service<
  UpdateCredentialsRemoteWriteConfig,
  "Stackit.Observability.UpdateCredentialsRemoteWriteConfig",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      request?: UpdateCredentialsRemoteWriteConfigRequest,
    ) => Effect.Effect<
      observability.CredentialsRemoteWriteConfig,
      observability.UpdateCredentialsRemoteWriteConfigError,
      RuntimeContext
    >
  >
> {}

export const UpdateCredentialsRemoteWriteConfig =
  Binding.Service<UpdateCredentialsRemoteWriteConfig>(
    "Stackit.Observability.UpdateCredentialsRemoteWriteConfig",
  );
