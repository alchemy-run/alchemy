import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

/** `StartVirtualMachine` request without the VM's identifiers, which the bound VM supplies. */
export interface StartVirtualMachineRequest extends Omit<
  compute.StartVirtualMachineRequest,
  "subscriptionId" | "resourceGroupName" | "vmName"
> {}

/**
 * Start (power on) a stopped or deallocated virtual machine. Azure accepts the
 * request and starts the VM in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeVirtualMachineStartRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachines/start/action`, on the VM only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes VMs, disks, and NICs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartVirtualMachineHttp}.
 *
 * ### Calling StartVirtualMachine
 * **Example:** StartVirtualMachine from a Function
 * ```typescript
 * const Vm = Azure.Compute.VirtualMachine("Vm", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vm = yield* Vm;
 *     const start = yield* Azure.Compute.StartVirtualMachine(vm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* start();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.StartVirtualMachineHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface StartVirtualMachine extends Binding.Service<
  StartVirtualMachine,
  "Azure.Compute.StartVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: StartVirtualMachineRequest,
    ) => Effect.Effect<
      compute.StartVirtualMachineResponse,
      compute.StartVirtualMachineError,
      RuntimeContext
    >
  >
> {}

export const StartVirtualMachine = Binding.Service<StartVirtualMachine>(
  "Azure.Compute.StartVirtualMachine",
);
