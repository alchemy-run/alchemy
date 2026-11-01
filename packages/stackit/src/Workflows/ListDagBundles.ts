import type * as workflows from "@distilled.cloud/stackit/workflows";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDagBundlesRequest extends Omit<
  workflows.ListDagBundlesRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Workflows `listDagBundles`: list where the instance loads DAGs from. Passwords and secret keys come back masked.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and provide
 * {@link ListDagBundlesHttp}. The instance's project, region and id are injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `workflows.dag-bundles.list`, the permission the API names for this operation, on the project holding the instance. STACKIT binds roles on an organization, folder or project only, so the grant reaches every Workflows instance in that project.
 *
 * ### Listing DAG Bundles
 * **Example:** List the bundles from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Airflow = Stackit.Workflows.Instance("Airflow", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const airflow = yield* Airflow;
 *     const listDagBundles = yield* Stackit.Workflows.ListDagBundles(airflow);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { dagBundles } = yield* listDagBundles({});
 *         return yield* HttpServerResponse.json(dagBundles.map((bundle) => bundle.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.ListDagBundlesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface ListDagBundles extends Binding.Service<
  ListDagBundles,
  "Stackit.Workflows.ListDagBundles",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListDagBundlesRequest,
    ) => Effect.Effect<
      workflows.ListDagBundlesResponseOutput,
      workflows.ListDagBundlesError,
      RuntimeContext
    >
  >
> {}

export const ListDagBundles = Binding.Service<ListDagBundles>("Stackit.Workflows.ListDagBundles");
