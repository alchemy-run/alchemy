import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface CancelTraceRetrievalRequest extends xray.CancelTraceRetrievalRequest {}

/**
 * Cancel an ongoing Transaction Search trace retrieval job by its
 * `RetrievalToken`.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.CancelTraceRetrievalHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:CancelTraceRetrieval`, so the binding grants it on `*`.
 * ### Transaction Search
 * **Example:** Cancel a retrieval job
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:CancelTraceRetrieval
 * const cancelTraceRetrieval = yield* XRay.CancelTraceRetrieval();
 *
 * // runtime
 * yield* cancelTraceRetrieval({ RetrievalToken: token });
 * ```
 *
 * @binding
 */
export interface CancelTraceRetrieval extends Binding.Service<
  CancelTraceRetrieval,
  "AWS.XRay.CancelTraceRetrieval",
  () => Effect.Effect<
    (
      request: CancelTraceRetrievalRequest,
    ) => Effect.Effect<xray.CancelTraceRetrievalResult, xray.CancelTraceRetrievalError>
  >
> {}
export const CancelTraceRetrieval = Binding.Service<CancelTraceRetrieval>(
  "AWS.XRay.CancelTraceRetrieval",
);

/**
 * HTTP implementation of the `XRay.CancelTraceRetrieval` binding.
 *
 * At deploy time it grants `xray:CancelTraceRetrieval` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const cancelTraceRetrieval = yield* XRay.CancelTraceRetrieval();
 *   // ...
 * }).pipe(Effect.provide(XRay.CancelTraceRetrievalHttp));
 * ```
 */
export const CancelTraceRetrievalHttp = Layer.effect(
  CancelTraceRetrieval,
  makeXRayHttpBinding({
    tag: "AWS.XRay.CancelTraceRetrieval",
    operation: xray.cancelTraceRetrieval,
    actions: ["xray:CancelTraceRetrieval"],
  }),
);
