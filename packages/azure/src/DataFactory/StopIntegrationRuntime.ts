import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IntegrationRuntime } from "./IntegrationRuntime.ts";

export interface StopIntegrationRuntimeRequest extends Omit<
  datafactory.StopIntegrationRuntimeRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName" | "integrationRuntimeName"
> {}

/**
 * Stop a managed (Azure-SSIS) Data Factory integration runtime (`POST
 * …/integrationRuntimes/{runtime}/stop`). A self-hosted or Azure runtime fails
 * with `IntegrationRuntimeNotManaged`.
 *
 * Binding assigns a custom role (`AzureDataFactoryStopIntegrationRuntimeRole`,
 * one per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/integrationruntimes/stop/action`, on the
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
 * const stopIntegrationRuntime = yield* Azure.DataFactory.StopIntegrationRuntime(runtime);
 *
 * // runtime
 * yield* stopIntegrationRuntime();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopIntegrationRuntime = yield* Azure.DataFactory.StopIntegrationRuntime(runtime);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.StopIntegrationRuntimeHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface StopIntegrationRuntime extends Binding.Service<
  StopIntegrationRuntime,
  "Azure.DataFactory.StopIntegrationRuntime",
  (
    runtime: IntegrationRuntime,
  ) => Effect.Effect<
    (
      request?: StopIntegrationRuntimeRequest,
    ) => Effect.Effect<
      datafactory.StopIntegrationRuntimeResponse,
      datafactory.StopIntegrationRuntimeError,
      RuntimeContext
    >
  >
> {}

export const StopIntegrationRuntime = Binding.Service<StopIntegrationRuntime>(
  "Azure.DataFactory.StopIntegrationRuntime",
);
