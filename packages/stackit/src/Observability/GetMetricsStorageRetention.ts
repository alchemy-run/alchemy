import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetMetricsStorageRetentionRequest extends Omit<
  observability.GetMetricsStorageRetentionRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getMetricsStorageRetention`: read how long an
 * instance keeps metrics at each resolution.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetMetricsStorageRetentionHttp}. The instance's project and id are
 * injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Reading Metrics Retention
 * **Example:** Read the raw retention from a Cloudflare Worker
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
 *     const getMetricsStorageRetention =
 *       yield* Stackit.Observability.GetMetricsStorageRetention(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getMetricsStorageRetention();
 *         return yield* HttpServerResponse.json({
 *           raw: live.metricsRetentionTimeRaw,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetMetricsStorageRetentionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetMetricsStorageRetention extends Binding.Service<
  GetMetricsStorageRetention,
  "Stackit.Observability.GetMetricsStorageRetention",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetMetricsStorageRetentionRequest,
    ) => Effect.Effect<
      observability.GetMetricsStorageRetentionResponse,
      observability.GetMetricsStorageRetentionError,
      RuntimeContext
    >
  >
> {}

export const GetMetricsStorageRetention = Binding.Service<GetMetricsStorageRetention>(
  "Stackit.Observability.GetMetricsStorageRetention",
);
