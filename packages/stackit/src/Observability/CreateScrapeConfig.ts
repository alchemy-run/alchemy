import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateScrapeConfigRequest extends Omit<
  observability.CreateScrapeConfigRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `createScrapeConfig`: add a scrape job to an
 * instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CreateScrapeConfigHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * Scrape jobs are eventually consistent: a job may not be readable right after this
 * returns.
 *
 * ### Registering a Target
 * **Example:** Register a job from a Cloudflare Worker
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
 *     const createScrapeConfig =
 *       yield* Stackit.Observability.CreateScrapeConfig(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* createScrapeConfig({
 *           jobName: "orders",
 *           scheme: "https",
 *           scrapeInterval: "5m",
 *           scrapeTimeout: "2m",
 *           metricsPath: "/metrics",
 *           staticConfigs: [{ targets: ["orders.example.com:443"] }],
 *         });
 *         return yield* HttpServerResponse.json({ jobs: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.CreateScrapeConfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface CreateScrapeConfig extends Binding.Service<
  CreateScrapeConfig,
  "Stackit.Observability.CreateScrapeConfig",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateScrapeConfigRequest,
    ) => Effect.Effect<
      observability.ScrapeConfigsResponse,
      observability.CreateScrapeConfigError,
      RuntimeContext
    >
  >
> {}

export const CreateScrapeConfig = Binding.Service<CreateScrapeConfig>(
  "Stackit.Observability.CreateScrapeConfig",
);
