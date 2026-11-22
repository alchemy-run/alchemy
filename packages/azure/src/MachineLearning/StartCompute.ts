import type * as machinelearningservices from "@distilled.cloud/azure/machinelearningservices";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Compute } from "./Compute.ts";

export interface StartComputeRequest extends Omit<
  machinelearningservices.StartComputeRequest,
  "subscriptionId" | "resourceGroupName" | "workspaceName" | "computeName"
> {}

/**
 * Start a stopped compute instance (`POST …/computes/{computeName}/start`) from any host.
 *
 * Binding assigns a custom role (`AzureMachineLearningStartComputeRole`, one per stack, with
 * exactly the action `Microsoft.MachineLearningServices/workspaces/computes/start/action`) on the compute only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartComputeHttp}.
 *
 * ### Calling StartCompute
 * **Example:** StartCompute from a Function
 * ```typescript
 * // init
 * const startCompute = yield* Azure.MachineLearning.StartCompute(compute);
 *
 * // runtime
 * yield* startCompute();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startCompute = yield* Azure.MachineLearning.StartCompute(compute);
 *   // ...
 * }).pipe(Effect.provide(Azure.MachineLearning.StartComputeHttp));
 * ```
 *
 * @binding
 * @category MachineLearning
 */
export interface StartCompute extends Binding.Service<
  StartCompute,
  "Azure.MachineLearning.StartCompute",
  (
    compute: Compute,
  ) => Effect.Effect<
    (
      request?: StartComputeRequest,
    ) => Effect.Effect<
      machinelearningservices.StartComputeResponse,
      machinelearningservices.StartComputeError,
      RuntimeContext
    >
  >
> {}

export const StartCompute = Binding.Service<StartCompute>("Azure.MachineLearning.StartCompute");
