import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface TriggerWakeupRequest extends Omit<
  ske.TriggerWakeupRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for SKE `triggerWakeup`: wake a hibernated cluster now. It
 * does nothing on a cluster already running, and the wake-up runs
 * asynchronously: follow it with `Stackit.SKE.GetCluster`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link TriggerWakeupHttp}. The cluster's project, region and name are
 * injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.wakeup` on the project
 * holding the cluster, so it reaches every cluster in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single cluster.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *

 * ### Saving Cost
 * **Example:** Wake the cluster from a Worker
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
 *     const wakeup = yield* Stackit.SKE.TriggerWakeup(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* wakeup();
 *         return HttpServerResponse.text("waking up");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.TriggerWakeupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface TriggerWakeup extends Binding.Service<
  TriggerWakeup,
  "Stackit.SKE.TriggerWakeup",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: TriggerWakeupRequest,
    ) => Effect.Effect<ske.TriggerWakeupResponse, ske.TriggerWakeupError, RuntimeContext>
  >
> {}

export const TriggerWakeup = Binding.Service<TriggerWakeup>("Stackit.SKE.TriggerWakeup");
