import type * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

export interface StopVirtualMachineRequest extends Omit<
  devtestlabs.StopVirtualMachineRequest,
  "subscriptionId" | "resourceGroupName" | "labName" | "name"
> {}

/**
 * Stop a lab VM (`POST …/labs/{labName}/virtualmachines/{name}/stop`) from any host.
 *
 * Binding assigns a custom role (`AzureDevTestLabsStopVirtualMachineRole`, one per stack, with
 * exactly the action `Microsoft.DevTestLab/labs/virtualMachines/Stop/action`) on the lab VM only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopVirtualMachineHttp}.
 *
 * ### Calling StopVirtualMachine
 * **Example:** StopVirtualMachine from a Function
 * ```typescript
 * // init
 * const stopVirtualMachine = yield* Azure.DevTestLabs.StopVirtualMachine(vm);
 *
 * // runtime
 * yield* stopVirtualMachine();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopVirtualMachine = yield* Azure.DevTestLabs.StopVirtualMachine(vm);
 *   // ...
 * }).pipe(Effect.provide(Azure.DevTestLabs.StopVirtualMachineHttp));
 * ```
 *
 * @binding
 * @category DevTestLabs
 */
export interface StopVirtualMachine extends Binding.Service<
  StopVirtualMachine,
  "Azure.DevTestLabs.StopVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: StopVirtualMachineRequest,
    ) => Effect.Effect<
      devtestlabs.StopVirtualMachineResponse,
      devtestlabs.StopVirtualMachineError,
      RuntimeContext
    >
  >
> {}

export const StopVirtualMachine = Binding.Service<StopVirtualMachine>(
  "Azure.DevTestLabs.StopVirtualMachine",
);
