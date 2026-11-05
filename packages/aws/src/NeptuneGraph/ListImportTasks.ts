import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IMPORT_TASK_ARN_WILDCARD, makeNeptuneGraphAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `ListImportTasks` operation (IAM action `neptune-graph:ListImportTasks`).
 *
 * Lists the account's Neptune Analytics import tasks. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.ListImportTasksHttp)`.
 * ### Importing and Exporting Data
 * **Example:** List import tasks
 * ```typescript
 * const listImportTasks = yield* NeptuneGraph.ListImportTasks();
 *
 * const { tasks } = yield* listImportTasks();
 * ```
 *
 * @binding
 */
export interface ListImportTasks extends Binding.Service<
  ListImportTasks,
  "AWS.NeptuneGraph.ListImportTasks",
  () => Effect.Effect<
    (
      request?: neptunegraph.ListImportTasksInput,
    ) => Effect.Effect<neptunegraph.ListImportTasksOutput, neptunegraph.ListImportTasksError>
  >
> {}
export const ListImportTasks = Binding.Service<ListImportTasks>("AWS.NeptuneGraph.ListImportTasks");

export const ListImportTasksHttp = Layer.effect(
  ListImportTasks,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.ListImportTasks",
    operation: neptunegraph.listImportTasks,
    actions: ["neptune-graph:ListImportTasks"],
    resources: [IMPORT_TASK_ARN_WILDCARD],
  }),
);
