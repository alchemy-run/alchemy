import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListCertChecksRequest extends Omit<
  observability.ListCertChecksRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listCertChecks`: list an instance's cert checks.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListCertChecksHttp}. The instance's project and id are injected into
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
 *     const listCertChecks = yield* Stackit.Observability.ListCertChecks(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listCertChecks();
 *         return yield* HttpServerResponse.json({
 *           ids: live.certChecks.map((check) => check.id),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListCertChecksHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListCertChecks extends Binding.Service<
  ListCertChecks,
  "Stackit.Observability.ListCertChecks",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListCertChecksRequest,
    ) => Effect.Effect<
      observability.CertCheckResponse,
      observability.ListCertChecksError,
      RuntimeContext
    >
  >
> {}

export const ListCertChecks = Binding.Service<ListCertChecks>(
  "Stackit.Observability.ListCertChecks",
);
