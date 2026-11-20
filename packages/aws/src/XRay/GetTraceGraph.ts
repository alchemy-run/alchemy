import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetTraceGraphRequest extends xray.GetTraceGraphRequest {}

/**
 * Retrieve a service graph scoped to specific trace IDs — the services
 * and edges the given traces traversed.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetTraceGraphHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetTraceGraph`, so the binding grants it on `*`.
 * ### Service Graphs & Statistics
 * **Example:** Graph the services one trace touched
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetTraceGraph
 * const getTraceGraph = yield* XRay.GetTraceGraph();
 *
 * // runtime
 * const graph = yield* getTraceGraph({
 *   TraceIds: ["1-63a2090f-3f4da4bcd9b1a3e07531423b"],
 * });
 * const services = graph.Services ?? [];
 * ```
 *
 * @binding
 */
export interface GetTraceGraph extends Binding.Service<
  GetTraceGraph,
  "AWS.XRay.GetTraceGraph",
  () => Effect.Effect<
    (
      request: GetTraceGraphRequest,
    ) => Effect.Effect<xray.GetTraceGraphResult, xray.GetTraceGraphError>
  >
> {}
export const GetTraceGraph = Binding.Service<GetTraceGraph>("AWS.XRay.GetTraceGraph");

/**
 * HTTP implementation of the `XRay.GetTraceGraph` binding.
 *
 * At deploy time it grants `xray:GetTraceGraph` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getTraceGraph = yield* XRay.GetTraceGraph();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetTraceGraphHttp));
 * ```
 */
export const GetTraceGraphHttp = Layer.effect(
  GetTraceGraph,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetTraceGraph",
    operation: xray.getTraceGraph,
    actions: ["xray:GetTraceGraph"],
  }),
);
