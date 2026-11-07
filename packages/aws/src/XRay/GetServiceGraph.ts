import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetServiceGraphRequest extends xray.GetServiceGraphRequest {}

/**
 * Retrieve the service graph for a time window — a document describing
 * the services processing requests and the downstream services they call.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetServiceGraphHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetServiceGraph`, so the binding grants it on `*`.
 * ### Service Graphs & Statistics
 * **Example:** Fetch the last 10 minutes of the service graph
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetServiceGraph
 * const getServiceGraph = yield* XRay.GetServiceGraph();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const graph = yield* getServiceGraph({
 *   StartTime: new Date(now - 10 * 60 * 1000),
 *   EndTime: new Date(now),
 * });
 * const services = graph.Services ?? [];
 * ```
 *
 * @binding
 */
export interface GetServiceGraph extends Binding.Service<
  GetServiceGraph,
  "AWS.XRay.GetServiceGraph",
  () => Effect.Effect<
    (
      request: GetServiceGraphRequest,
    ) => Effect.Effect<xray.GetServiceGraphResult, xray.GetServiceGraphError>
  >
> {}
export const GetServiceGraph = Binding.Service<GetServiceGraph>("AWS.XRay.GetServiceGraph");

/**
 * HTTP implementation of the `XRay.GetServiceGraph` binding.
 *
 * At deploy time it grants `xray:GetServiceGraph` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getServiceGraph = yield* XRay.GetServiceGraph();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetServiceGraphHttp));
 * ```
 */
export const GetServiceGraphHttp = Layer.effect(
  GetServiceGraph,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetServiceGraph",
    operation: xray.getServiceGraph,
    actions: ["xray:GetServiceGraph"],
  }),
);
