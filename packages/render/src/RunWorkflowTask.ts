import type { CancelTaskRunError, CreateTaskError, GetTaskRunError } from "@distilled.cloud/render";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { RenderOperationTimeoutError, RenderTaskRunFailedError } from "./Errors.ts";
import type { TaskRunStatus } from "./Types.ts";
import type { Workflow } from "./Workflow.ts";

export interface TaskRunInfo {
  /** Render task run identifier (`trn-...`). */
  readonly id: string;
  /** Qualified task identifier (`<workflow-slug>/<task-name>`). */
  readonly task: string;
  /** Execution lifecycle status (`"pending"`, `"running"`, `"completed"`, `"succeeded"`, `"failed"`, `"canceled"`). */
  readonly status: TaskRunStatus;
  /** JSON input payload passed to the task run. */
  readonly input?: unknown;
  /** Result payload emitted by the task run. */
  readonly results?: unknown;
  /** Legacy/alternative output payload field, if present. */
  readonly output?: unknown;
  /** Failure error message, if failed. */
  readonly error?: string;
  /** Execution start timestamp (ISO 8601). */
  readonly startedAt?: string;
  /** Completion timestamp (ISO 8601). */
  readonly completedAt?: string;
  /** Finished timestamp (ISO 8601). */
  readonly finishedAt?: string;
  /** Creation timestamp (ISO 8601). */
  readonly createdAt?: string;
  /** Last update timestamp (ISO 8601). */
  readonly updatedAt?: string;
}

export const runWorkflowTaskEnvKeys = (workflow: Pick<Workflow, "LogicalId">) => {
  const id = workflow.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    slug: `RENDER_WORKFLOW_${id}_SLUG`,
    id: `RENDER_WORKFLOW_${id}_ID`,
  } as const;
};

export class WorkflowSlugMissing extends Data.TaggedError("Render.WorkflowSlugMissing")<{
  readonly resourceName: string;
}> {}

export interface RunWorkflowTaskClient {
  /** Render workflow slug used as the `<workflow-slug>/<task-name>` task prefix. */
  readonly workflowSlug: Effect.Effect<string, WorkflowSlugMissing, RuntimeContext>;
  /** Start an asynchronous Render Workflow task run (`POST /v1/task-runs`). */
  readonly trigger: (
    taskName: string,
    input?: unknown,
  ) => Effect.Effect<TaskRunInfo, CreateTaskError | WorkflowSlugMissing, RuntimeContext>;
  /** Fetch the current status and results of a task run (`GET /v1/task-runs/{id}`). */
  readonly getRun: (taskRunId: string) => Effect.Effect<TaskRunInfo, GetTaskRunError>;
  /** Cancel an in-progress task run (`DELETE /v1/task-runs/{id}`). */
  readonly cancelRun: (taskRunId: string) => Effect.Effect<void, CancelTaskRunError>;
  /** Trigger a task run and poll until completion, failing with {@link RenderTaskRunFailedError} on failure. */
  readonly runAndWait: (
    taskName: string,
    input?: unknown,
  ) => Effect.Effect<
    TaskRunInfo,
    | CreateTaskError
    | GetTaskRunError
    | RenderOperationTimeoutError
    | RenderTaskRunFailedError
    | WorkflowSlugMissing,
    RuntimeContext
  >;
}

/**
 * Bind a Render {@link Workflow} to a Render compute service or foreign
 * runtime host to invoke workflow tasks via `/v1/task-runs`.
 *
 * At deploy time, binds `RENDER_WORKFLOW_<ID>_SLUG`, `RENDER_WORKFLOW_<ID>_ID`,
 * and Render API credentials into the host's `RuntimeContext`. Provide
 * {@link RunWorkflowTaskHttp}.
 *
 * **Example:** Trigger and await a workflow task from a web handler
 * ```typescript
 * const jobs = yield* Render.RunWorkflowTask(workflow);
 * const result = yield* jobs.runAndWait("send-digest", { userId: "usr_123" });
 * ```
 *
 * @binding
 * @product Workflows
 * @category Compute
 */
export interface RunWorkflowTask extends Binding.Service<
  RunWorkflowTask,
  "Render.RunWorkflowTask",
  (workflow: Workflow) => Effect.Effect<RunWorkflowTaskClient>
> {}

export const RunWorkflowTask = Binding.Service<RunWorkflowTask>("Render.RunWorkflowTask");
