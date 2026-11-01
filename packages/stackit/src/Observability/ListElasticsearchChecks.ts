import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListElasticsearchChecksRequest extends Omit<
  observability.ListElasticsearchChecksRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listElasticsearchChecks`: list an instance's
 * Elasticsearch checks.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListElasticsearchChecksHttp}. The instance's project and id are
 * injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * The API returns a check's `password` in the response, as a `Redacted` value. Keep it
 * out of logs and responses.
 *
 * ### Listing Checks
 * **Example:** List the check ids from a Cloudflare Worker
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
 *     const listElasticsearchChecks =
 *       yield* Stackit.Observability.ListElasticsearchChecks(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listElasticsearchChecks();
 *         return yield* HttpServerResponse.json({
 *           ids: live.elasticsearchChecks.map((check) => check.id),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListElasticsearchChecksHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListElasticsearchChecks extends Binding.Service<
  ListElasticsearchChecks,
  "Stackit.Observability.ListElasticsearchChecks",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListElasticsearchChecksRequest,
    ) => Effect.Effect<
      observability.ElasticsearchCheckResponse,
      observability.ListElasticsearchChecksError,
      RuntimeContext
    >
  >
> {}

export const ListElasticsearchChecks = Binding.Service<ListElasticsearchChecks>(
  "Stackit.Observability.ListElasticsearchChecks",
);
