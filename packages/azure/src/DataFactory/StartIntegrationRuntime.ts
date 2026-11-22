import type * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IntegrationRuntime } from "./IntegrationRuntime.ts";

export interface StartIntegrationRuntimeRequest extends Omit<
  datafactory.StartIntegrationRuntimeRequest,
  "subscriptionId" | "resourceGroupName" | "factoryName" | "integrationRuntimeName"
> {}

/**
 * Start a managed (Azure-SSIS) Data Factory integration runtime (`POST
 * …/integrationRuntimes/{runtime}/start`). Azure answers when the start is
 * accepted; the runtime takes minutes to reach `Started`. A self-hosted or
 * Azure runtime fails with `IntegrationRuntimeNotManaged`.
 *
 * Binding assigns a custom role
 * (`AzureDataFactoryStartIntegrationRuntimeRole`, one per stack, shared by
 * every host of this binding) with exactly the action
 * `Microsoft.DataFactory/factories/integrationruntimes/start/action`, on the
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
 * const startIntegrationRuntime = yield* Azure.DataFactory.StartIntegrationRuntime(runtime);
 *
 * // runtime
 * yield* startIntegrationRuntime();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startIntegrationRuntime = yield* Azure.DataFactory.StartIntegrationRuntime(runtime);
 *   // ...
 * }).pipe(Effect.provide(Azure.DataFactory.StartIntegrationRuntimeHttp));
 * ```
 *
 * @binding
 * @category DataFactory
 */
export interface StartIntegrationRuntime extends Binding.Service<
  StartIntegrationRuntime,
  "Azure.DataFactory.StartIntegrationRuntime",
  (
    runtime: IntegrationRuntime,
  ) => Effect.Effect<
    (
      request?: StartIntegrationRuntimeRequest,
    ) => Effect.Effect<
      datafactory.StartIntegrationRuntimeResponse,
      datafactory.StartIntegrationRuntimeError,
      RuntimeContext
    >
  >
> {}

export const StartIntegrationRuntime = Binding.Service<StartIntegrationRuntime>(
  "Azure.DataFactory.StartIntegrationRuntime",
);
