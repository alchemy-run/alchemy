import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface CreateKubeconfigRequest extends Omit<
  ske.CreateKubeconfigRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for SKE `createKubeconfig`: mint an admin kubeconfig from a
 * running host, for a process that talks to the cluster on its own schedule.
 * The `kubeconfig` of the response is `Redacted`. `expirationSeconds` is a
 * string on the wire and takes 600 (10 minutes) to 15552000 (6 months); it
 * defaults to 3600.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link CreateKubeconfigHttp}. The cluster's project, region and name
 * are injected into each request. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.kubeconfig.create` on the
 * project holding the cluster, so it reaches every cluster in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * cluster. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * This hands the host full control of the cluster, by a credential that can't
 * be revoked before it expires, except by a credentials rotation that
 * invalidates every kubeconfig of the cluster. Mint short lifetimes and don't
 * log the result.
 *

 * ### Minting Credentials
 * **Example:** Mint a kubeconfig valid for ten minutes
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
 *     const createKubeconfig = yield* Stackit.SKE.CreateKubeconfig(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const minted = yield* createKubeconfig({ expirationSeconds: "600" });
 *         return yield* HttpServerResponse.json({ expires: minted.expirationTimestamp });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.CreateKubeconfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface CreateKubeconfig extends Binding.Service<
  CreateKubeconfig,
  "Stackit.SKE.CreateKubeconfig",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: CreateKubeconfigRequest,
    ) => Effect.Effect<ske.Kubeconfig, ske.CreateKubeconfigError, RuntimeContext>
  >
> {}

export const CreateKubeconfig = Binding.Service<CreateKubeconfig>("Stackit.SKE.CreateKubeconfig");
