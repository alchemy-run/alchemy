import * as omics from "@distilled.cloud/aws/omics";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOmicsAccountHttpBinding } from "./BindingHttp.ts";

export interface CancelRunRequest extends omics.CancelRunRequest {}

/**
 * Runtime binding for `omics:CancelRun`.
 *
 * An account-level run-control operation (no resource argument) that cancels an in-progress run.
 * Provide the implementation with `Effect.provide(AWS.Omics.CancelRunHttp)`.
 * ### Runs
 * **Example:** Call CancelRun
 * ```typescript
 * // init — account-level binding takes no resource
 * const cancelRun = yield* AWS.Omics.CancelRun();
 * // runtime
 * const result = yield* cancelRun({ id: runId });
 * ```
 *
 * @binding
 */
export interface CancelRun extends Binding.Service<
  CancelRun,
  "AWS.Omics.CancelRun",
  () => Effect.Effect<
    (request?: CancelRunRequest) => Effect.Effect<omics.CancelRunResponse, omics.CancelRunError>
  >
> {}

export const CancelRun = Binding.Service<CancelRun>("AWS.Omics.CancelRun");

export const CancelRunHttp = Layer.effect(
  CancelRun,
  makeOmicsAccountHttpBinding({
    tag: "AWS.Omics.CancelRun",
    operation: omics.cancelRun,
    actions: ["omics:CancelRun"],
  }),
);
