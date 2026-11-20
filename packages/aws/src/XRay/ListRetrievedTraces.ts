import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface ListRetrievedTracesRequest extends xray.ListRetrievedTracesRequest {}

/**
 * Retrieve the traces fetched by a Transaction Search retrieval job.
 * Returns an empty response until the job's `RetrievalStatus` is
 * `COMPLETE`.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.ListRetrievedTracesHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:ListRetrievedTraces`, so the binding grants it on `*`.
 * ### Transaction Search
 * **Example:** Poll a retrieval job for its traces
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:ListRetrievedTraces
 * const listRetrievedTraces = yield* XRay.ListRetrievedTraces();
 *
 * // runtime
 * const result = yield* listRetrievedTraces({ RetrievalToken: token });
 * if (result.RetrievalStatus === "COMPLETE") {
 *   const traces = result.Traces ?? [];
 * }
 * ```
 *
 * @binding
 */
export interface ListRetrievedTraces extends Binding.Service<
  ListRetrievedTraces,
  "AWS.XRay.ListRetrievedTraces",
  () => Effect.Effect<
    (
      request: ListRetrievedTracesRequest,
    ) => Effect.Effect<xray.ListRetrievedTracesResult, xray.ListRetrievedTracesError>
  >
> {}
export const ListRetrievedTraces = Binding.Service<ListRetrievedTraces>(
  "AWS.XRay.ListRetrievedTraces",
);

/**
 * HTTP implementation of the `XRay.ListRetrievedTraces` binding.
 *
 * At deploy time it grants `xray:ListRetrievedTraces` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const listRetrievedTraces = yield* XRay.ListRetrievedTraces();
 *   // ...
 * }).pipe(Effect.provide(XRay.ListRetrievedTracesHttp));
 * ```
 */
export const ListRetrievedTracesHttp = Layer.effect(
  ListRetrievedTraces,
  makeXRayHttpBinding({
    tag: "AWS.XRay.ListRetrievedTraces",
    operation: xray.listRetrievedTraces,
    actions: ["xray:ListRetrievedTraces"],
  }),
);
