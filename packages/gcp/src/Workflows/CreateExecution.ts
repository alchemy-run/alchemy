import * as workflowexecutions from "@distilled.cloud/gcp/workflowexecutions_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { Workflow } from "./Workflow.ts";

export interface CreateExecutionRequest extends Omit<
  workflowexecutions.CreateProjectsLocationsWorkflowsExecutionsRequest,
  "parent"
> {}

/**
 * Runtime binding for Workflows `executions.create`.
 *
 * Starts a new execution of the latest revision of a {@link Workflow}.
 * Bind this operation in a Function/Action init phase. Provide
 * {@link CreateExecutionHttp}.
 *
 * ### Starting Executions
 * **Example:** Run the bound workflow
 * ```typescript
 * const createExecution = yield* GCP.Workflows.CreateExecution(greet);
 * const execution = yield* createExecution({
 *   body: { argument: JSON.stringify({ name: "world" }) },
 * });
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface CreateExecution extends Binding.Service<
  CreateExecution,
  "GCP.Workflows.CreateExecution",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request?: CreateExecutionRequest,
    ) => Effect.Effect<
      workflowexecutions.Execution,
      workflowexecutions.CreateProjectsLocationsWorkflowsExecutionsError,
      RuntimeContext
    >
  >
> {}

export const CreateExecution = Binding.Service<CreateExecution>("GCP.Workflows.CreateExecution");

/**
 * HTTP implementation of {@link CreateExecution}.
 *
 * @layer
 * @provides GCP.Workflows.CreateExecution
 */
export const CreateExecutionHttp = Layer.effect(
  CreateExecution,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const createExecution = yield* GCPBindings.withCredentials(
      workflowexecutions.createProjectsLocationsWorkflowsExecutions,
    );
    return Effect.fn(function* (workflow: Workflow) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Workflows.CreateExecution(${workflow})`({
          // Workflows has no resource-level IAM; invoker is granted on the project.
          iam: [{ role: "roles/workflows.invoker" }],
        });
      }
      const name = yield* workflow.name;
      return Effect.fn(`GCP.Workflows.CreateExecution(${workflow.LogicalId})`)(function* (
        request?: CreateExecutionRequest,
      ) {
        const parent = yield* name;
        return yield* createExecution({ ...request, parent });
      });
    });
  }),
);
