import type * as workflows from "@distilled.cloud/stackit/workflows";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDagBundleRequest extends Omit<
  workflows.GetDagBundleRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Workflows `getDagBundle`: read one DAG source of the instance. Passwords and secret keys come back masked.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and provide
 * {@link GetDagBundleHttp}. The instance's project, region and id are injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `workflows.dag-bundles.get`, the permission the API names for this operation, on the project holding the instance. STACKIT binds roles on an organization, folder or project only, so the grant reaches every Workflows instance in that project.
 *
 * ### Reading a DAG Bundle
 * **Example:** Read a bundle from a Cloudflare Worker
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
 *     const getDagBundle = yield* Stackit.Workflows.GetDagBundle(airflow);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bundle = yield* getDagBundle({ bundleName: "reports" });
 *         return yield* HttpServerResponse.json({ type: bundle.type, name: bundle.name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.GetDagBundleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface GetDagBundle extends Binding.Service<
  GetDagBundle,
  "Stackit.Workflows.GetDagBundle",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDagBundleRequest,
    ) => Effect.Effect<workflows.GetDagBundleResponse, workflows.GetDagBundleError, RuntimeContext>
  >
> {}

export const GetDagBundle = Binding.Service<GetDagBundle>("Stackit.Workflows.GetDagBundle");
