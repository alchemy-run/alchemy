import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface StartCredentialsRotationRequest extends Omit<
  ske.StartCredentialsRotationRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for SKE `startCredentialsRotation`: step one of a cluster's
 * two-step credentials rotation. It runs asynchronously:
 * `status.credentialsRotation.phase` from `Stackit.SKE.GetCluster` reaches
 * `PREPARED`. Move clients to new credentials, then finish with
 * `Stackit.SKE.CompleteCredentialsRotation`.
 *
 * Rotation is imperative, so it's a binding and not a resource prop: there is
 * no desired state to converge on.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link StartCredentialsRotationHttp}. The cluster's project, region
 * and name are injected into each request. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.credential.rotate` on the
 * project holding the cluster, so it reaches every cluster in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * cluster. The deployer needs `iam.role.add` on that scope to define the role.
 *

 * ### Rotating Credentials
 * **Example:** Start a rotation from an operator Worker
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
 *     const startRotation = yield* Stackit.SKE.StartCredentialsRotation(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* startRotation();
 *         return HttpServerResponse.text("preparing");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.StartCredentialsRotationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface StartCredentialsRotation extends Binding.Service<
  StartCredentialsRotation,
  "Stackit.SKE.StartCredentialsRotation",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: StartCredentialsRotationRequest,
    ) => Effect.Effect<
      ske.StartCredentialsRotationResponse,
      ske.StartCredentialsRotationError,
      RuntimeContext
    >
  >
> {}

export const StartCredentialsRotation = Binding.Service<StartCredentialsRotation>(
  "Stackit.SKE.StartCredentialsRotation",
);
