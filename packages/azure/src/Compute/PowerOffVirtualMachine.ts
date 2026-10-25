import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

/** `VirtualMachinesPowerOff` request without the VM's identifiers, which the bound VM supplies. */
export interface PowerOffVirtualMachineRequest extends Omit<
  compute.VirtualMachinesPowerOffRequest,
  "subscriptionId" | "resourceGroupName" | "vmName"
> {}

/**
 * Power off (stop) a virtual machine. The VM keeps its compute allocation and
 * is still billed; use `DeallocateVirtualMachine` to release it. Azure
 * accepts the request and stops the VM in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeVirtualMachinePowerOffRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachines/powerOff/action`, on the VM only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes VMs, disks, and NICs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PowerOffVirtualMachineHttp}.
 *
 * ### Calling PowerOffVirtualMachine
 * **Example:** PowerOffVirtualMachine from a Function
 * ```typescript
 * const Vm = Azure.Compute.VirtualMachine("Vm", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vm = yield* Vm;
 *     const powerOff = yield* Azure.Compute.PowerOffVirtualMachine(vm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* powerOff({ skipShutdown: false });
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.PowerOffVirtualMachineHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface PowerOffVirtualMachine extends Binding.Service<
  PowerOffVirtualMachine,
  "Azure.Compute.PowerOffVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: PowerOffVirtualMachineRequest,
    ) => Effect.Effect<
      compute.VirtualMachinesPowerOffResponse,
      compute.VirtualMachinesPowerOffError,
      RuntimeContext
    >
  >
> {}

export const PowerOffVirtualMachine = Binding.Service<PowerOffVirtualMachine>(
  "Azure.Compute.PowerOffVirtualMachine",
);
