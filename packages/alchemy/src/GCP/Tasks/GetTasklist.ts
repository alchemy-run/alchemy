import type * as tasks from "@distilled.cloud/gcp/tasks_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Tasklist } from "./Tasklist.ts";

export interface GetTasklistRequest extends Omit<
  tasks.GetTasklistsRequest,
  "tasklist"
> {}

/**
 * Runtime binding for Tasks `tasklists.get`.
 *
 * Bind this operation to a {@link Tasklist} in a Function/Action init
 * phase. Provide {@link GetTasklistHttp}.
 *
 * ### Reading Task Lists
 * **Example:** Read task list metadata
 * ```typescript
 * const getTasklist = yield* GCP.Tasks.GetTasklist(list);
 * const metadata = yield* getTasklist({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Tasks
 */
export interface GetTasklist extends Binding.Service<
  GetTasklist,
  "GCP.Tasks.GetTasklist",
  (
    list: Tasklist,
  ) => Effect.Effect<
    (
      request: GetTasklistRequest,
    ) => Effect.Effect<tasks.TaskList, tasks.GetTasklistsError, RuntimeContext>
  >
> {}

export const GetTasklist = Binding.Service<GetTasklist>(
  "GCP.Tasks.GetTasklist",
);
