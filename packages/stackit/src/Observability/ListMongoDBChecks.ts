import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListMongoDBChecksRequest extends Omit<
  observability.ListMongodbChecksRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listMongodbChecks`: list an instance's MongoDB
 * checks.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListMongoDBChecksHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
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
 *     const listMongoDBChecks =
 *       yield* Stackit.Observability.ListMongoDBChecks(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listMongoDBChecks();
 *         return yield* HttpServerResponse.json({
 *           ids: live.mongodbChecks.map((check) => check.id),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListMongoDBChecksHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListMongoDBChecks extends Binding.Service<
  ListMongoDBChecks,
  "Stackit.Observability.ListMongoDBChecks",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListMongoDBChecksRequest,
    ) => Effect.Effect<
      observability.MongodbCheckResponse,
      observability.ListMongodbChecksError,
      RuntimeContext
    >
  >
> {}

export const ListMongoDBChecks = Binding.Service<ListMongoDBChecks>(
  "Stackit.Observability.ListMongoDBChecks",
);
