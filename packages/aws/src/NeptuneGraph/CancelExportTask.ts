import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EXPORT_TASK_ARN_WILDCARD, makeNeptuneGraphAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `CancelExportTask` operation (IAM action `neptune-graph:CancelExportTask`).
 *
 * Cancels a running export task by id. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.CancelExportTaskHttp)`.
 * ### Importing and Exporting Data
 * **Example:** Cancel an export
 * ```typescript
 * const cancelExport = yield* NeptuneGraph.CancelExportTask();
 *
 * yield* cancelExport({ taskIdentifier });
 * ```
 *
 * @binding
 */
export interface CancelExportTask extends Binding.Service<
  CancelExportTask,
  "AWS.NeptuneGraph.CancelExportTask",
  () => Effect.Effect<
    (
      request: neptunegraph.CancelExportTaskInput,
    ) => Effect.Effect<neptunegraph.CancelExportTaskOutput, neptunegraph.CancelExportTaskError>
  >
> {}
export const CancelExportTask = Binding.Service<CancelExportTask>(
  "AWS.NeptuneGraph.CancelExportTask",
);

export const CancelExportTaskHttp = Layer.effect(
  CancelExportTask,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.CancelExportTask",
    operation: neptunegraph.cancelExportTask,
    actions: ["neptune-graph:CancelExportTask"],
    resources: [EXPORT_TASK_ARN_WILDCARD],
  }),
);
