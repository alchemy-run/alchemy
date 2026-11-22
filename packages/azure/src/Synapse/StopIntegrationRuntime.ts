import type * as synapse from "@distilled.cloud/azure/synapse";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IntegrationRuntime } from "./IntegrationRuntime.ts";

export interface StopIntegrationRuntimeRequest extends Omit<
  synapse.StopIntegrationRuntimeRequest,
  "subscriptionId" | "resourceGroupName" | "workspaceName" | "integrationRuntimeName"
> {}

/**
 * Stop a managed (Azure-SSIS) Synapse integration runtime (`POST
 * …/integrationRuntimes/{runtime}/stop`).
 *
 * Binding assigns a custom role (`AzureSynapseStopIntegrationRuntimeRole`, one
 * per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Synapse/workspaces/integrationRuntimes/stop/action`, on the
 * integration runtime only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or AKS
 * workload identity) the role goes to that identity; any other host (a
 * Cloudflare Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link StopIntegrationRuntimeHttp}.
 *
 * ### Calling StopIntegrationRuntime
 * **Example:** StopIntegrationRuntime from a Function
 * ```typescript
 * // init
 * const stopIntegrationRuntime = yield* Azure.Synapse.StopIntegrationRuntime(runtime);
 *
 * // runtime
 * yield* stopIntegrationRuntime();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopIntegrationRuntime = yield* Azure.Synapse.StopIntegrationRuntime(runtime);
 *   // ...
 * }).pipe(Effect.provide(Azure.Synapse.StopIntegrationRuntimeHttp));
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface StopIntegrationRuntime extends Binding.Service<
  StopIntegrationRuntime,
  "Azure.Synapse.StopIntegrationRuntime",
  (
    runtime: IntegrationRuntime,
  ) => Effect.Effect<
    (
      request?: StopIntegrationRuntimeRequest,
    ) => Effect.Effect<
      synapse.StopIntegrationRuntimeResponse,
      synapse.StopIntegrationRuntimeError,
      RuntimeContext
    >
  >
> {}

export const StopIntegrationRuntime = Binding.Service<StopIntegrationRuntime>(
  "Azure.Synapse.StopIntegrationRuntime",
);
