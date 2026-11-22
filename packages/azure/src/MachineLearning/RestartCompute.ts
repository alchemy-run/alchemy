import type * as machinelearningservices from "@distilled.cloud/azure/machinelearningservices";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Compute } from "./Compute.ts";

export interface RestartComputeRequest extends Omit<
  machinelearningservices.RestartComputeRequest,
  "subscriptionId" | "resourceGroupName" | "workspaceName" | "computeName"
> {}

/**
 * Restart a compute instance (`POST …/computes/{computeName}/restart`) from any host.
 *
 * Binding assigns a custom role (`AzureMachineLearningRestartComputeRole`, one per stack, with
 * exactly the action `Microsoft.MachineLearningServices/workspaces/computes/restart/action`) on the compute only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartComputeHttp}.
 *
 * ### Calling RestartCompute
 * **Example:** RestartCompute from a Function
 * ```typescript
 * // init
 * const restartCompute = yield* Azure.MachineLearning.RestartCompute(compute);
 *
 * // runtime
 * yield* restartCompute();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const restartCompute = yield* Azure.MachineLearning.RestartCompute(compute);
 *   // ...
 * }).pipe(Effect.provide(Azure.MachineLearning.RestartComputeHttp));
 * ```
 *
 * @binding
 * @category MachineLearning
 */
export interface RestartCompute extends Binding.Service<
  RestartCompute,
  "Azure.MachineLearning.RestartCompute",
  (
    compute: Compute,
  ) => Effect.Effect<
    (
      request?: RestartComputeRequest,
    ) => Effect.Effect<
      machinelearningservices.RestartComputeResponse,
      machinelearningservices.RestartComputeError,
      RuntimeContext
    >
  >
> {}

export const RestartCompute = Binding.Service<RestartCompute>(
  "Azure.MachineLearning.RestartCompute",
);
