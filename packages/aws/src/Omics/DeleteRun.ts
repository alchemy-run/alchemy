import * as omics from "@distilled.cloud/aws/omics";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOmicsAccountHttpBinding } from "./BindingHttp.ts";

export interface DeleteRunRequest extends omics.DeleteRunRequest {}

/**
 * Runtime binding for `omics:DeleteRun`.
 *
 * An account-level run-control operation (no resource argument) that deletes a completed run.
 * Provide the implementation with `Effect.provide(AWS.Omics.DeleteRunHttp)`.
 * ### Runs
 * **Example:** Call DeleteRun
 * ```typescript
 * // init — account-level binding takes no resource
 * const deleteRun = yield* AWS.Omics.DeleteRun();
 * // runtime
 * const result = yield* deleteRun({ id: runId });
 * ```
 *
 * @binding
 */
export interface DeleteRun extends Binding.Service<
  DeleteRun,
  "AWS.Omics.DeleteRun",
  () => Effect.Effect<
    (request?: DeleteRunRequest) => Effect.Effect<omics.DeleteRunResponse, omics.DeleteRunError>
  >
> {}

export const DeleteRun = Binding.Service<DeleteRun>("AWS.Omics.DeleteRun");

export const DeleteRunHttp = Layer.effect(
  DeleteRun,
  makeOmicsAccountHttpBinding({
    tag: "AWS.Omics.DeleteRun",
    operation: omics.deleteRun,
    actions: ["omics:DeleteRun"],
  }),
);
