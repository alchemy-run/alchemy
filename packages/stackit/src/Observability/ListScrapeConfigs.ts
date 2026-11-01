import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListScrapeConfigsRequest extends Omit<
  observability.ListScrapeConfigsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listScrapeConfigs`: list an instance's scrape
 * jobs.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListScrapeConfigsHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * The response holds each job's bearer token, basic auth password and OAuth secret as
 * `Redacted` values. Keep them out of logs and responses.
 *
 * ### Listing Jobs
 * **Example:** List the job names from a Cloudflare Worker
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
 *     const listScrapeConfigs =
 *       yield* Stackit.Observability.ListScrapeConfigs(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listScrapeConfigs();
 *         return yield* HttpServerResponse.json({
 *           jobs: live.data.map((job) => job.jobName),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListScrapeConfigsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListScrapeConfigs extends Binding.Service<
  ListScrapeConfigs,
  "Stackit.Observability.ListScrapeConfigs",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListScrapeConfigsRequest,
    ) => Effect.Effect<
      observability.ListScrapeConfigsResponse,
      observability.ListScrapeConfigsError,
      RuntimeContext
    >
  >
> {}

export const ListScrapeConfigs = Binding.Service<ListScrapeConfigs>(
  "Stackit.Observability.ListScrapeConfigs",
);
