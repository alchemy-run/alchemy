import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

/** `RestartVirtualMachine` request without the VM's identifiers, which the bound VM supplies. */
export interface RestartVirtualMachineRequest extends Omit<
  compute.RestartVirtualMachineRequest,
  "subscriptionId" | "resourceGroupName" | "vmName"
> {}

/**
 * Restart a running virtual machine. Azure accepts the request and restarts
 * the VM in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeVirtualMachineRestartRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachines/restart/action`, on the VM only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes VMs, disks, and NICs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartVirtualMachineHttp}.
 *
 * ### Calling RestartVirtualMachine
 * **Example:** RestartVirtualMachine from a Function
 * ```typescript
 * const Vm = Azure.Compute.VirtualMachine("Vm", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vm = yield* Vm;
 *     const restart = yield* Azure.Compute.RestartVirtualMachine(vm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restart();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.RestartVirtualMachineHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface RestartVirtualMachine extends Binding.Service<
  RestartVirtualMachine,
  "Azure.Compute.RestartVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: RestartVirtualMachineRequest,
    ) => Effect.Effect<
      compute.RestartVirtualMachineResponse,
      compute.RestartVirtualMachineError,
      RuntimeContext
    >
  >
> {}

export const RestartVirtualMachine = Binding.Service<RestartVirtualMachine>(
  "Azure.Compute.RestartVirtualMachine",
);
