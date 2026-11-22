import type * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

export interface StartVirtualMachineRequest extends Omit<
  devtestlabs.StartVirtualMachineRequest,
  "subscriptionId" | "resourceGroupName" | "labName" | "name"
> {}

/**
 * Start a lab VM (`POST …/labs/{labName}/virtualmachines/{name}/start`) from any host.
 *
 * Binding assigns a custom role (`AzureDevTestLabsStartVirtualMachineRole`, one per stack, with
 * exactly the action `Microsoft.DevTestLab/labs/virtualMachines/Start/action`) on the lab VM only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartVirtualMachineHttp}.
 *
 * ### Calling StartVirtualMachine
 * **Example:** StartVirtualMachine from a Function
 * ```typescript
 * // init
 * const startVirtualMachine = yield* Azure.DevTestLabs.StartVirtualMachine(vm);
 *
 * // runtime
 * yield* startVirtualMachine();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startVirtualMachine = yield* Azure.DevTestLabs.StartVirtualMachine(vm);
 *   // ...
 * }).pipe(Effect.provide(Azure.DevTestLabs.StartVirtualMachineHttp));
 * ```
 *
 * @binding
 * @category DevTestLabs
 */
export interface StartVirtualMachine extends Binding.Service<
  StartVirtualMachine,
  "Azure.DevTestLabs.StartVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: StartVirtualMachineRequest,
    ) => Effect.Effect<
      devtestlabs.StartVirtualMachineResponse,
      devtestlabs.StartVirtualMachineError,
      RuntimeContext
    >
  >
> {}

export const StartVirtualMachine = Binding.Service<StartVirtualMachine>(
  "Azure.DevTestLabs.StartVirtualMachine",
);
