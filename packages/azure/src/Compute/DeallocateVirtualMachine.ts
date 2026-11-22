import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

/** `VirtualMachinesDeallocate` request without the VM's identifiers, which the bound VM supplies. */
export interface DeallocateVirtualMachineRequest extends Omit<
  compute.VirtualMachinesDeallocateRequest,
  "subscriptionId" | "resourceGroupName" | "vmName"
> {}

/**
 * Shut down a virtual machine and release its compute resources, so it is no
 * longer billed for compute. Azure accepts the request and deallocates the VM
 * in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeVirtualMachineDeallocateRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachines/deallocate/action`, on the VM only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes VMs, disks, and NICs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeallocateVirtualMachineHttp}.
 *
 * ### Calling DeallocateVirtualMachine
 * **Example:** DeallocateVirtualMachine from a Function
 * ```typescript
 * const Vm = Azure.Compute.VirtualMachine("Vm", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vm = yield* Vm;
 *     const deallocate = yield* Azure.Compute.DeallocateVirtualMachine(vm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deallocate();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.DeallocateVirtualMachineHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface DeallocateVirtualMachine extends Binding.Service<
  DeallocateVirtualMachine,
  "Azure.Compute.DeallocateVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: DeallocateVirtualMachineRequest,
    ) => Effect.Effect<
      compute.VirtualMachinesDeallocateResponse,
      compute.VirtualMachinesDeallocateError,
      RuntimeContext
    >
  >
> {}

export const DeallocateVirtualMachine = Binding.Service<DeallocateVirtualMachine>(
  "Azure.Compute.DeallocateVirtualMachine",
);
