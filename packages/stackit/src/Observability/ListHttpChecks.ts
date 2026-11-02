import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListHttpChecksRequest extends Omit<
  observability.ListHttpChecksRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listHttpChecks`: list an instance's HTTP checks.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListHttpChecksHttp}. The instance's project and id are injected into
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
 *     const listHttpChecks = yield* Stackit.Observability.ListHttpChecks(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listHttpChecks();
 *         return yield* HttpServerResponse.json({
 *           ids: live.httpChecks.map((check) => check.id),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListHttpChecksHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListHttpChecks extends Binding.Service<
  ListHttpChecks,
  "Stackit.Observability.ListHttpChecks",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListHttpChecksRequest,
    ) => Effect.Effect<
      observability.HttpCheckResponse,
      observability.ListHttpChecksError,
      RuntimeContext
    >
  >
> {}

export const ListHttpChecks = Binding.Service<ListHttpChecks>(
  "Stackit.Observability.ListHttpChecks",
);
