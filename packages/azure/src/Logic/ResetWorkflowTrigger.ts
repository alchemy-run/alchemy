import type * as logic from "@distilled.cloud/azure/logic";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workflow } from "./Workflow.ts";

export interface ResetWorkflowTriggerRequest extends Omit<
  logic.ResetWorkflowTriggerRequest,
  "subscriptionId" | "resourceGroupName" | "workflowName"
> {}

/**
 * Reset a workflow trigger's state (`POST …/triggers/{triggerName}/reset`), e.g. a polling trigger's watermark, from any host.
 * Only stateful polling connector triggers support reset; a `Recurrence`,
 * `Http` or request trigger fails with `WorkflowTriggerResetNotSupported`.
 *
 * Binding assigns a custom role (`AzureLogicResetWorkflowTriggerRole`, one per stack, with
 * exactly the action `Microsoft.Logic/workflows/triggers/reset/action`) on the workflow only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ResetWorkflowTriggerHttp}.
 *
 * ### Calling ResetWorkflowTrigger
 * **Example:** ResetWorkflowTrigger from a Function
 * ```typescript
 * // init
 * const resetWorkflowTrigger = yield* Azure.Logic.ResetWorkflowTrigger(workflow);
 *
 * // runtime
 * yield* resetWorkflowTrigger({ triggerName: "recurrence" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const resetWorkflowTrigger = yield* Azure.Logic.ResetWorkflowTrigger(workflow);
 *   // ...
 * }).pipe(Effect.provide(Azure.Logic.ResetWorkflowTriggerHttp));
 * ```
 *
 * @binding
 * @category Logic
 */
export interface ResetWorkflowTrigger extends Binding.Service<
  ResetWorkflowTrigger,
  "Azure.Logic.ResetWorkflowTrigger",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request: ResetWorkflowTriggerRequest,
    ) => Effect.Effect<
      logic.ResetWorkflowTriggerResponse,
      logic.ResetWorkflowTriggerError,
      RuntimeContext
    >
  >
> {}

export const ResetWorkflowTrigger = Binding.Service<ResetWorkflowTrigger>(
  "Azure.Logic.ResetWorkflowTrigger",
);
