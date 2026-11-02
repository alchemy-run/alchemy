import type * as edge from "@distilled.cloud/stackit/edge";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Instance } from "./Instance.ts";

export interface GetKubeconfigRequest extends Omit<
  edge.GetKubeconfigByInstanceIdRequest,
  "projectId" | "regionId" | "instanceId"
> {}

export interface GetKubeconfigResponse {
  /** The kubeconfig, as JSON, which `kubectl` reads as YAML. */
  kubeconfig: Redacted.Redacted<string>;
}

/**
 * Runtime binding for Edge Cloud `getKubeconfigByInstanceId`: mint a kubeconfig from
 * a running host, for a process that talks to the instance's Kubernetes API on its
 * own schedule. The response's `kubeconfig` is `Redacted`, and is JSON text.
 * `expirationSeconds` takes 600 (10 minutes) to 15552000 (6 months), and defaults
 * to 3600. A kubeconfig can't be revoked before it expires. Mint short lifetimes and
 * don't log the result.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetKubeconfigHttp}. The instance's project, region and id are
 * injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `edge.instances.create` on the project holding
 * the instance, so it reaches every instance in that project: STACKIT binds roles on
 * projects, folders and organizations, not on a single instance. STACKIT's API spec
 * names that action for this call, so the role also lets the host create instances.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Minting Credentials
 * **Example:** Mint a kubeconfig valid for ten minutes
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Edge = Stackit.EdgeCloud.Instance("Edge", {
 *   planId: "11111111-2222-3333-4444-555555555555",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getKubeconfig = yield* Stackit.EdgeCloud.GetKubeconfig(yield* Edge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { kubeconfig } = yield* getKubeconfig({ expirationSeconds: 600 });
 *         const { clusters } = JSON.parse(Redacted.value(kubeconfig));
 *         return yield* HttpServerResponse.json({ clusters: clusters.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.EdgeCloud.GetKubeconfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Edge Cloud
 * @category EdgeCloud
 */
export interface GetKubeconfig extends Binding.Service<
  GetKubeconfig,
  "Stackit.EdgeCloud.GetKubeconfig",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetKubeconfigRequest,
    ) => Effect.Effect<GetKubeconfigResponse, edge.GetKubeconfigByInstanceIdError, RuntimeContext>
  >
> {}

export const GetKubeconfig = Binding.Service<GetKubeconfig>("Stackit.EdgeCloud.GetKubeconfig");
