import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListPingChecksRequest extends Omit<
  observability.ListPingChecksRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listPingChecks`: list an instance's ping checks.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListPingChecksHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
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
 *     const listPingChecks = yield* Stackit.Observability.ListPingChecks(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listPingChecks();
 *         return yield* HttpServerResponse.json({
 *           ids: live.pingChecks.map((check) => check.id),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListPingChecksHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListPingChecks extends Binding.Service<
  ListPingChecks,
  "Stackit.Observability.ListPingChecks",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListPingChecksRequest,
    ) => Effect.Effect<
      observability.PingCheckResponse,
      observability.ListPingChecksError,
      RuntimeContext
    >
  >
> {}

export const ListPingChecks = Binding.Service<ListPingChecks>(
  "Stackit.Observability.ListPingChecks",
);
