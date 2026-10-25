import type * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

export interface RestartVirtualMachineRequest extends Omit<
  devtestlabs.RestartVirtualMachineRequest,
  "subscriptionId" | "resourceGroupName" | "labName" | "name"
> {}

/**
 * Restart a lab VM (`POST …/labs/{labName}/virtualmachines/{name}/restart`) from any host.
 *
 * Binding assigns a custom role (`AzureDevTestLabsRestartVirtualMachineRole`, one per stack, with
 * exactly the action `Microsoft.DevTestLab/labs/virtualMachines/Restart/action`) on the lab VM only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartVirtualMachineHttp}.
 *
 * ### Calling RestartVirtualMachine
 * **Example:** RestartVirtualMachine from a Function
 * ```typescript
 * // init
 * const restartVirtualMachine = yield* Azure.DevTestLabs.RestartVirtualMachine(vm);
 *
 * // runtime
 * yield* restartVirtualMachine();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const restartVirtualMachine = yield* Azure.DevTestLabs.RestartVirtualMachine(vm);
 *   // ...
 * }).pipe(Effect.provide(Azure.DevTestLabs.RestartVirtualMachineHttp));
 * ```
 *
 * @binding
 * @category DevTestLabs
 */
export interface RestartVirtualMachine extends Binding.Service<
  RestartVirtualMachine,
  "Azure.DevTestLabs.RestartVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: RestartVirtualMachineRequest,
    ) => Effect.Effect<
      devtestlabs.RestartVirtualMachineResponse,
      devtestlabs.RestartVirtualMachineError,
      RuntimeContext
    >
  >
> {}

export const RestartVirtualMachine = Binding.Service<RestartVirtualMachine>(
  "Azure.DevTestLabs.RestartVirtualMachine",
);
