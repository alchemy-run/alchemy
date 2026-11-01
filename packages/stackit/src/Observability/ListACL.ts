import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListACLRequest extends Omit<
  observability.ListACLRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listACL`: read the CIDR ranges allowed to reach
 * an instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListACLHttp}. The instance's project and id are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Reading the ACL
 * **Example:** Read the ACL from a Cloudflare Worker
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
 *     const listACL = yield* Stackit.Observability.ListACL(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listACL();
 *         return yield* HttpServerResponse.json({ acl: live.acl });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListACLHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListACL extends Binding.Service<
  ListACL,
  "Stackit.Observability.ListACL",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListACLRequest,
    ) => Effect.Effect<observability.ListACLResponse, observability.ListACLError, RuntimeContext>
  >
> {}

export const ListACL = Binding.Service<ListACL>("Stackit.Observability.ListACL");
