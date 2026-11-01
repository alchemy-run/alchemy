import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface TriggerHibernateRequest extends Omit<
  ske.TriggerHibernateRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for SKE `triggerHibernate`: hibernate a cluster now, from a
 * scheduled job that saves its workers' cost outside working hours. It does
 * nothing on a cluster already hibernated, and hibernation runs asynchronously:
 * follow it with `Stackit.SKE.GetCluster`. The control plane keeps billing
 * while hibernated. For a fixed timetable, the `hibernation` prop of
 * `Stackit.SKE.Cluster` is simpler.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link TriggerHibernateHttp}. The cluster's project, region and name
 * are injected into each request. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.hibernate` on the project
 * holding the cluster, so it reaches every cluster in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single cluster.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *

 * ### Saving Cost
 * **Example:** Hibernate the cluster from a Worker
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
 *     const hibernate = yield* Stackit.SKE.TriggerHibernate(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* hibernate();
 *         return HttpServerResponse.text("hibernating");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.TriggerHibernateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface TriggerHibernate extends Binding.Service<
  TriggerHibernate,
  "Stackit.SKE.TriggerHibernate",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: TriggerHibernateRequest,
    ) => Effect.Effect<ske.TriggerHibernateResponse, ske.TriggerHibernateError, RuntimeContext>
  >
> {}

export const TriggerHibernate = Binding.Service<TriggerHibernate>("Stackit.SKE.TriggerHibernate");
