import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetScrapeConfigRequest extends Omit<
  observability.GetScrapeConfigRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getScrapeConfig`: read one scrape job.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetScrapeConfigHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * The response holds a job's bearer token, basic auth password and OAuth secret as
 * `Redacted` values. Keep them out of logs and responses.
 *
 * ### Reading a Job
 * **Example:** Read a job from a Cloudflare Worker
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
 *     const getScrapeConfig = yield* Stackit.Observability.GetScrapeConfig(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getScrapeConfig({ jobName: "orders" });
 *         return yield* HttpServerResponse.json({
 *           interval: live.data.scrapeInterval,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetScrapeConfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetScrapeConfig extends Binding.Service<
  GetScrapeConfig,
  "Stackit.Observability.GetScrapeConfig",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetScrapeConfigRequest,
    ) => Effect.Effect<
      observability.GetScrapeConfigResponse,
      observability.GetScrapeConfigError,
      RuntimeContext
    >
  >
> {}

export const GetScrapeConfig = Binding.Service<GetScrapeConfig>(
  "Stackit.Observability.GetScrapeConfig",
);
