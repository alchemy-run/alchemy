import type * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

export interface RedeployVirtualMachineRequest extends Omit<
  devtestlabs.RedeployVirtualMachineRequest,
  "subscriptionId" | "resourceGroupName" | "labName" | "name"
> {}

/**
 * Redeploy a lab VM to a new Azure host (`POST …/labs/{labName}/virtualmachines/{name}/redeploy`) from any host.
 *
 * Binding assigns a custom role (`AzureDevTestLabsRedeployVirtualMachineRole`, one per stack, with
 * exactly the action `Microsoft.DevTestLab/labs/virtualMachines/Redeploy/action`) on the lab VM only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RedeployVirtualMachineHttp}.
 *
 * ### Calling RedeployVirtualMachine
 * **Example:** RedeployVirtualMachine from a Function
 * ```typescript
 * // init
 * const redeployVirtualMachine = yield* Azure.DevTestLabs.RedeployVirtualMachine(vm);
 *
 * // runtime
 * yield* redeployVirtualMachine();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const redeployVirtualMachine = yield* Azure.DevTestLabs.RedeployVirtualMachine(vm);
 *   // ...
 * }).pipe(Effect.provide(Azure.DevTestLabs.RedeployVirtualMachineHttp));
 * ```
 *
 * @binding
 * @category DevTestLabs
 */
export interface RedeployVirtualMachine extends Binding.Service<
  RedeployVirtualMachine,
  "Azure.DevTestLabs.RedeployVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: RedeployVirtualMachineRequest,
    ) => Effect.Effect<
      devtestlabs.RedeployVirtualMachineResponse,
      devtestlabs.RedeployVirtualMachineError,
      RuntimeContext
    >
  >
> {}

export const RedeployVirtualMachine = Binding.Service<RedeployVirtualMachine>(
  "Azure.DevTestLabs.RedeployVirtualMachine",
);
