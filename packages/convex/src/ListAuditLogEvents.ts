import * as deploymentApi from "@distilled.cloud/convex/deployment";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { hostKey, onHost } from "./BindingHttp.ts";
import type { Deployment } from "./Deployment.ts";

/** List audit log events on or after `from`, oldest first, one page at a time. */
export type ListAuditLogEventsClient = (
  request: deploymentApi.ListAuditLogEventsRequest,
) => Effect.Effect<
  deploymentApi.ListDeploymentAuditLogEventsResponse,
  deploymentApi.ListAuditLogEventsError,
  RuntimeContext
>;

/**
 * Read a Convex deployment's audit log from a Worker, Lambda or other host.
 *
 * The host gets a deploy key that can only do `deployment:auditLog:view` on
 * this deployment.
 *
 * :::caution
 * Plans that keep no audit logs fail with `AuditLogsTooOld`.
 * :::
 *
 * ### Reading the Audit Log
 * **Example:** Events from the last hour
 * ```typescript
 * Effect.gen(function* () {
 *   const audit = yield* Convex.ListAuditLogEvents(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const page = yield* audit({ from: Date.now() - 3_600_000 });
 *       return yield* HttpServerResponse.json(page.items);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.ListAuditLogEventsHttp));
 * ```
 *
 * @binding
 * @product Deployment
 */
export interface ListAuditLogEvents extends Binding.Service<
  ListAuditLogEvents,
  "Convex.ListAuditLogEvents",
  (deployment: Deployment) => Effect.Effect<ListAuditLogEventsClient>
> {}

export const ListAuditLogEvents = Binding.Service<ListAuditLogEvents>("Convex.ListAuditLogEvents");

/** Implementation over the Deployment API, usable from any host. */
export const ListAuditLogEventsHttp = Layer.effect(
  ListAuditLogEvents,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const key = yield* hostKey(deployment, "Audit", ["deployment:auditLog:view"]);
      const on = onHost(yield* deployment.url, key);
      const client: ListAuditLogEventsClient = (request) =>
        deploymentApi.listAuditLogEvents(request).pipe(on);
      return client;
    }),
  ),
);
