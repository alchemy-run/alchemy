import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RenderTaskRunFailedError } from "./Errors.ts";
import * as Client from "./internal/Client.ts";
import { pollUntil } from "./internal/Poll.ts";
import { isRenderHost } from "./RenderBindings.ts";
import {
  RunWorkflowTask,
  WorkflowSlugMissing,
  runWorkflowTaskEnvKeys,
  type RunWorkflowTaskClient,
  type TaskRunInfo,
} from "./RunWorkflowTask.ts";
import type { Workflow } from "./Workflow.ts";

const readConfigString = (key: string): Effect.Effect<string | undefined> =>
  Config.String(key).pipe(Config.option, Effect.orDie, Effect.map(Option.getOrUndefined));

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A> | A,
): Effect.Effect<A, never, RuntimeContext> =>
  Output.isOutput(output)
    ? output.bind(key).pipe(Effect.flatMap((effect) => effect))
    : Effect.succeed(output);

const resolveWorkflowSlug = (
  key: string,
  output: Output.Output<string> | string,
  resourceName: string,
): Effect.Effect<string, WorkflowSlugMissing, RuntimeContext> =>
  Effect.gen(function* () {
    const rt = yield* CurrentRuntimeContext;
    if (rt) {
      const stored = yield* rt.get<string>(sanitizeKey(key));
      if (typeof stored === "string" && stored.length > 0) {
        return stored;
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const evaluated = yield* runtimeOutput(key, output);
        if (typeof evaluated === "string" && evaluated.length > 0) {
          return evaluated;
        }
      }
    }
    const configured = yield* readConfigString(key);
    if (typeof configured === "string" && configured.length > 0) {
      return configured;
    }
    return yield* new WorkflowSlugMissing({ resourceName });
  });

/**
 * HTTP implementation of {@link RunWorkflowTask}.
 *
 * **Example:** Provide `RunWorkflowTaskHttp` to workflow callers
 * ```typescript
 * Effect.gen(function* () {
 *   const jobs = yield* Render.RunWorkflowTask(workflow);
 *   return yield* jobs.trigger("sync-users", { full: true });
 * }).pipe(Effect.provide(Render.RunWorkflowTaskHttp));
 * ```
 *
 * @layer
 * @product Workflows
 * @provides Render.RunWorkflowTask
 */
export const RunWorkflowTaskHttp = Layer.effect(
  RunWorkflowTask,
  Effect.succeed(
    Effect.fn(function* (workflow: Workflow) {
      const keys = runWorkflowTaskEnvKeys(workflow);
      const resourceName = workflow.LogicalId;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isRenderHost(host)) {
          yield* host.bind`${workflow}`({
            env: {
              [keys.slug]: workflow.slug,
              [keys.id]: workflow.id,
            },
          });
        } else {
          const rt = yield* CurrentRuntimeContext;
          if (rt) {
            yield* rt.set(sanitizeKey(keys.slug), workflow.slug);
            yield* rt.set(sanitizeKey(keys.id), workflow.id);
          }
        }
      }

      const workflowSlug = resolveWorkflowSlug(keys.slug, workflow.slug, resourceName);

      const trigger: RunWorkflowTaskClient["trigger"] = (taskName, input) =>
        Effect.gen(function* () {
          const slug = yield* workflowSlug;
          const qualifiedTask = taskName.includes("/") ? taskName : `${slug}/${taskName}`;
          const created = yield* Client.createTaskRun({
            task: qualifiedTask,
            ...(input !== undefined ? { input } : {}),
          });
          return created satisfies TaskRunInfo;
        });

      const getRun: RunWorkflowTaskClient["getRun"] = (taskRunId) => Client.getTaskRun(taskRunId);

      const cancelRun: RunWorkflowTaskClient["cancelRun"] = (taskRunId) =>
        Client.cancelTaskRun(taskRunId);

      const runAndWait: RunWorkflowTaskClient["runAndWait"] = (taskName, input) =>
        Effect.gen(function* () {
          const initial = yield* trigger(taskName, input);
          if (initial.status === "completed" || initial.status === "succeeded") {
            return initial;
          }
          if (initial.status === "failed" || initial.status === "canceled") {
            return yield* new RenderTaskRunFailedError({
              taskRunId: initial.id,
              task: initial.task,
              status: initial.status,
              message:
                initial.error ??
                `Render task run ${initial.id} (${initial.task}) entered terminal status "${initial.status}"`,
            });
          }
          return yield* pollUntil({
            operation: `workflow task run ${initial.task}`,
            resourceId: initial.id,
            check: Client.getTaskRun(initial.id),
            statusOf: (r) => r.status,
            failIf: (r) => {
              if (r.status === "failed" || r.status === "canceled") {
                return new RenderTaskRunFailedError({
                  taskRunId: r.id,
                  task: r.task,
                  status: r.status,
                  message:
                    r.error ??
                    `Render task run ${r.id} (${r.task}) entered terminal status "${r.status}"`,
                });
              }
              return undefined;
            },
            isDone: (r) => r.status === "completed" || r.status === "succeeded",
          });
        });

      return {
        workflowSlug,
        trigger,
        getRun,
        cancelRun,
        runAndWait,
      } satisfies RunWorkflowTaskClient;
    }),
  ),
);
