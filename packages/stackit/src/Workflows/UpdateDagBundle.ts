import type * as workflows from "@distilled.cloud/stackit/workflows";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateDagBundleRequest extends Omit<
  workflows.UpdateDagBundleRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Workflows `updateDagBundle`: move a DAG source to another branch, tag or prefix, such as to promote a release. The API can't change a bundle's type, and wants its credentials again when its URL, bucket or endpoint changes. Only Airflow 3 instances have bundles.
 *
 * A change made here is one the instance's `dagBundles` prop doesn't know of: the next deploy that changes the props sets the bundle back to what they say.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and provide
 * {@link UpdateDagBundleHttp}. The instance's project, region and id are injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `workflows.dag-bundles.update`, the permission the API names for this operation, on the project holding the instance. STACKIT binds roles on an organization, folder or project only, so the grant reaches every Workflows instance in that project.
 *
 * ### Promoting a Release
 * **Example:** Move a bundle to a tag from a Cloudflare Worker
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
 *     const updateDagBundle = yield* Stackit.Workflows.UpdateDagBundle(airflow);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bundle = yield* updateDagBundle({
 *           bundleName: "reports",
 *           body: { type: "git", branch: "v2.0.0" },
 *         });
 *         return yield* HttpServerResponse.json({ name: bundle.name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.UpdateDagBundleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface UpdateDagBundle extends Binding.Service<
  UpdateDagBundle,
  "Stackit.Workflows.UpdateDagBundle",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateDagBundleRequest,
    ) => Effect.Effect<
      workflows.UpdateDagBundleResponse,
      workflows.UpdateDagBundleError,
      RuntimeContext
    >
  >
> {}

export const UpdateDagBundle = Binding.Service<UpdateDagBundle>(
  "Stackit.Workflows.UpdateDagBundle",
);
