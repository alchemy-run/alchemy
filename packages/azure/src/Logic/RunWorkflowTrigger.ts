import type * as logic from "@distilled.cloud/azure/logic";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workflow } from "./Workflow.ts";

export interface RunWorkflowTriggerRequest extends Omit<
  logic.TriggerRunWorkflowRequest,
  "subscriptionId" | "resourceGroupName" | "workflowName"
> {}

/**
 * Fire one of a workflow's triggers now (`POST …/triggers/{triggerName}/run`), starting a run the way the trigger would, from any host.
 *
 * Binding assigns a custom role (`AzureLogicRunWorkflowTriggerRole`, one per stack, with
 * exactly the action `Microsoft.Logic/workflows/triggers/run/action`) on the workflow only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RunWorkflowTriggerHttp}.
 *
 * ### Calling RunWorkflowTrigger
 * **Example:** RunWorkflowTrigger from a Function
 * ```typescript
 * // init
 * const runWorkflowTrigger = yield* Azure.Logic.RunWorkflowTrigger(workflow);
 *
 * // runtime
 * yield* runWorkflowTrigger({ triggerName: "recurrence" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const runWorkflowTrigger = yield* Azure.Logic.RunWorkflowTrigger(workflow);
 *   // ...
 * }).pipe(Effect.provide(Azure.Logic.RunWorkflowTriggerHttp));
 * ```
 *
 * @binding
 * @category Logic
 */
export interface RunWorkflowTrigger extends Binding.Service<
  RunWorkflowTrigger,
  "Azure.Logic.RunWorkflowTrigger",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request: RunWorkflowTriggerRequest,
    ) => Effect.Effect<
      logic.TriggerRunWorkflowResponse,
      logic.TriggerRunWorkflowError,
      RuntimeContext
    >
  >
> {}

export const RunWorkflowTrigger = Binding.Service<RunWorkflowTrigger>(
  "Azure.Logic.RunWorkflowTrigger",
);
