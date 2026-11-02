import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface CompleteCredentialsRotationRequest extends Omit<
  ske.CompleteCredentialsRotationRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for SKE `completeCredentialsRotation`: step two of a
 * cluster's credentials rotation, after `Stackit.SKE.StartCredentialsRotation`.
 * It runs asynchronously: `status.credentialsRotation.phase` from
 * `Stackit.SKE.GetCluster` reaches `COMPLETED`.
 *
 * This revokes the kubeconfigs minted before it, the only revocation STACKIT
 * offers. A `Stackit.SKE.Kubeconfig` mints a new one on the next deploy, and
 * the `stackit-ske` cluster adapter on its next connection.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link CompleteCredentialsRotationHttp}. The cluster's project,
 * region and name are injected into each request. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.credential.rotate` on the
 * project holding the cluster, so it reaches every cluster in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * cluster. The deployer needs `iam.role.add` on that scope to define the role.
 *

 * ### Rotating Credentials
 * **Example:** Complete a rotation from an operator Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Workers = Stackit.SKE.Cluster("Workers", {
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const completeRotation = yield* Stackit.SKE.CompleteCredentialsRotation(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* completeRotation();
 *         return HttpServerResponse.text("completing");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.CompleteCredentialsRotationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface CompleteCredentialsRotation extends Binding.Service<
  CompleteCredentialsRotation,
  "Stackit.SKE.CompleteCredentialsRotation",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: CompleteCredentialsRotationRequest,
    ) => Effect.Effect<
      ske.CompleteCredentialsRotationResponse,
      ske.CompleteCredentialsRotationError,
      RuntimeContext
    >
  >
> {}

export const CompleteCredentialsRotation = Binding.Service<CompleteCredentialsRotation>(
  "Stackit.SKE.CompleteCredentialsRotation",
);
