import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateScrapeConfigRequest extends Omit<
  observability.UpdateScrapeConfigRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `updateScrapeConfig`: replace a scrape job's
 * settings.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link UpdateScrapeConfigHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If a `ScrapeConfig` resource declares this job, its next reconcile overwrites what
 * this binding changed.
 *
 * The job's `httpSdConfigs` and `oauth2` can't change through this operation: the
 * API's update takes neither.
 *
 * ### Updating a Job
 * **Example:** Slow a job down from a Cloudflare Worker
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
 *     const updateScrapeConfig =
 *       yield* Stackit.Observability.UpdateScrapeConfig(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateScrapeConfig({
 *           jobName: "orders",
 *           scheme: "https",
 *           scrapeInterval: "10m",
 *           scrapeTimeout: "2m",
 *           metricsPath: "/metrics",
 *           staticConfigs: [{ targets: ["orders.example.com:443"] }],
 *         });
 *         return yield* HttpServerResponse.json({ jobs: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.UpdateScrapeConfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface UpdateScrapeConfig extends Binding.Service<
  UpdateScrapeConfig,
  "Stackit.Observability.UpdateScrapeConfig",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateScrapeConfigRequest,
    ) => Effect.Effect<
      observability.ScrapeConfigsResponse,
      observability.UpdateScrapeConfigError,
      RuntimeContext
    >
  >
> {}

export const UpdateScrapeConfig = Binding.Service<UpdateScrapeConfig>(
  "Stackit.Observability.UpdateScrapeConfig",
);
