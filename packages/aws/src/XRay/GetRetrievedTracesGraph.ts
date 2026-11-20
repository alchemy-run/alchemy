import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetRetrievedTracesGraphRequest extends xray.GetRetrievedTracesGraphRequest {}

/**
 * Retrieve the service graph of the traces fetched by a Transaction
 * Search retrieval job.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetRetrievedTracesGraphHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetRetrievedTracesGraph`, so the binding grants it on `*`.
 * ### Transaction Search
 * **Example:** Graph a retrieval job's traces
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetRetrievedTracesGraph
 * const getRetrievedTracesGraph = yield* XRay.GetRetrievedTracesGraph();
 *
 * // runtime
 * const graph = yield* getRetrievedTracesGraph({ RetrievalToken: token });
 * const services = graph.Services ?? [];
 * ```
 *
 * @binding
 */
export interface GetRetrievedTracesGraph extends Binding.Service<
  GetRetrievedTracesGraph,
  "AWS.XRay.GetRetrievedTracesGraph",
  () => Effect.Effect<
    (
      request: GetRetrievedTracesGraphRequest,
    ) => Effect.Effect<xray.GetRetrievedTracesGraphResult, xray.GetRetrievedTracesGraphError>
  >
> {}
export const GetRetrievedTracesGraph = Binding.Service<GetRetrievedTracesGraph>(
  "AWS.XRay.GetRetrievedTracesGraph",
);

/**
 * HTTP implementation of the `XRay.GetRetrievedTracesGraph` binding.
 *
 * At deploy time it grants `xray:GetRetrievedTracesGraph` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getRetrievedTracesGraph = yield* XRay.GetRetrievedTracesGraph();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetRetrievedTracesGraphHttp));
 * ```
 */
export const GetRetrievedTracesGraphHttp = Layer.effect(
  GetRetrievedTracesGraph,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetRetrievedTracesGraph",
    operation: xray.getRetrievedTracesGraph,
    actions: ["xray:GetRetrievedTracesGraph"],
  }),
);
