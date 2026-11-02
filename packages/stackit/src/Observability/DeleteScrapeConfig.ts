import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteScrapeConfigRequest extends Omit<
  observability.DeleteScrapeConfigRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `deleteScrapeConfig`: remove one scrape job.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteScrapeConfigHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If a `ScrapeConfig` resource declares this job, its next reconcile creates it again.
 *
 * ### Removing a Job
 * **Example:** Deregister a job from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const deleteScrapeConfig =
 *       yield* Stackit.Observability.DeleteScrapeConfig(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* deleteScrapeConfig({ jobName: "orders" });
 *         return yield* HttpServerResponse.json({ jobs: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.DeleteScrapeConfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface DeleteScrapeConfig extends Binding.Service<
  DeleteScrapeConfig,
  "Stackit.Observability.DeleteScrapeConfig",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteScrapeConfigRequest,
    ) => Effect.Effect<
      observability.DeleteScrapeConfigResponse,
      observability.DeleteScrapeConfigError,
      RuntimeContext
    >
  >
> {}

export const DeleteScrapeConfig = Binding.Service<DeleteScrapeConfig>(
  "Stackit.Observability.DeleteScrapeConfig",
);
