import type * as machinelearningservices from "@distilled.cloud/azure/machinelearningservices";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Compute } from "./Compute.ts";

export interface StopComputeRequest extends Omit<
  machinelearningservices.StopComputeRequest,
  "subscriptionId" | "resourceGroupName" | "workspaceName" | "computeName"
> {}

/**
 * Stop a running compute instance (`POST …/computes/{computeName}/stop`) so it stops billing compute hours, from any host.
 *
 * Binding assigns a custom role (`AzureMachineLearningStopComputeRole`, one per stack, with
 * exactly the action `Microsoft.MachineLearningServices/workspaces/computes/stop/action`) on the compute only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopComputeHttp}.
 *
 * ### Calling StopCompute
 * **Example:** StopCompute from a Function
 * ```typescript
 * // init
 * const stopCompute = yield* Azure.MachineLearning.StopCompute(compute);
 *
 * // runtime
 * yield* stopCompute();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopCompute = yield* Azure.MachineLearning.StopCompute(compute);
 *   // ...
 * }).pipe(Effect.provide(Azure.MachineLearning.StopComputeHttp));
 * ```
 *
 * @binding
 * @category MachineLearning
 */
export interface StopCompute extends Binding.Service<
  StopCompute,
  "Azure.MachineLearning.StopCompute",
  (
    compute: Compute,
  ) => Effect.Effect<
    (
      request?: StopComputeRequest,
    ) => Effect.Effect<
      machinelearningservices.StopComputeResponse,
      machinelearningservices.StopComputeError,
      RuntimeContext
    >
  >
> {}

export const StopCompute = Binding.Service<StopCompute>("Azure.MachineLearning.StopCompute");
