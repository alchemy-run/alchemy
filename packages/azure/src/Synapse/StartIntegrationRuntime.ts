import type * as synapse from "@distilled.cloud/azure/synapse";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IntegrationRuntime } from "./IntegrationRuntime.ts";

export interface StartIntegrationRuntimeRequest extends Omit<
  synapse.StartIntegrationRuntimeRequest,
  "subscriptionId" | "resourceGroupName" | "workspaceName" | "integrationRuntimeName"
> {}

/**
 * Start a managed (Azure-SSIS) Synapse integration runtime (`POST
 * …/integrationRuntimes/{runtime}/start`).
 *
 * Binding assigns a custom role (`AzureSynapseStartIntegrationRuntimeRole`,
 * one per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Synapse/workspaces/integrationRuntimes/start/action`, on the
 * integration runtime only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or AKS
 * workload identity) the role goes to that identity; any other host (a
 * Cloudflare Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link StartIntegrationRuntimeHttp}.
 *
 * ### Calling StartIntegrationRuntime
 * **Example:** StartIntegrationRuntime from a Function
 * ```typescript
 * // init
 * const startIntegrationRuntime = yield* Azure.Synapse.StartIntegrationRuntime(runtime);
 *
 * // runtime
 * yield* startIntegrationRuntime();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startIntegrationRuntime = yield* Azure.Synapse.StartIntegrationRuntime(runtime);
 *   // ...
 * }).pipe(Effect.provide(Azure.Synapse.StartIntegrationRuntimeHttp));
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface StartIntegrationRuntime extends Binding.Service<
  StartIntegrationRuntime,
  "Azure.Synapse.StartIntegrationRuntime",
  (
    runtime: IntegrationRuntime,
  ) => Effect.Effect<
    (
      request?: StartIntegrationRuntimeRequest,
    ) => Effect.Effect<
      synapse.IntegrationRuntimeStatusResponse,
      synapse.StartIntegrationRuntimeError,
      RuntimeContext
    >
  >
> {}

export const StartIntegrationRuntime = Binding.Service<StartIntegrationRuntime>(
  "Azure.Synapse.StartIntegrationRuntime",
);
