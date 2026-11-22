import type * as logic from "@distilled.cloud/azure/logic";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workflow } from "./Workflow.ts";

export interface CancelWorkflowRunRequest extends Omit<
  logic.CancelWorkflowRunRequest,
  "subscriptionId" | "resourceGroupName" | "workflowName"
> {}

/**
 * Cancel a running or waiting workflow run (`POST …/runs/{runName}/cancel`) from any host.
 *
 * Binding assigns a custom role (`AzureLogicCancelWorkflowRunRole`, one per stack, with
 * exactly the action `Microsoft.Logic/workflows/runs/cancel/action`) on the workflow only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelWorkflowRunHttp}.
 *
 * ### Calling CancelWorkflowRun
 * **Example:** CancelWorkflowRun from a Function
 * ```typescript
 * // init
 * const cancelWorkflowRun = yield* Azure.Logic.CancelWorkflowRun(workflow);
 *
 * // runtime
 * yield* cancelWorkflowRun({ runName: "08585…" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const cancelWorkflowRun = yield* Azure.Logic.CancelWorkflowRun(workflow);
 *   // ...
 * }).pipe(Effect.provide(Azure.Logic.CancelWorkflowRunHttp));
 * ```
 *
 * @binding
 * @category Logic
 */
export interface CancelWorkflowRun extends Binding.Service<
  CancelWorkflowRun,
  "Azure.Logic.CancelWorkflowRun",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request: CancelWorkflowRunRequest,
    ) => Effect.Effect<
      logic.CancelWorkflowRunResponse,
      logic.CancelWorkflowRunError,
      RuntimeContext
    >
  >
> {}

export const CancelWorkflowRun = Binding.Service<CancelWorkflowRun>(
  "Azure.Logic.CancelWorkflowRun",
);
