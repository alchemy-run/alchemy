import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

/** `RedeployVirtualMachine` request without the VM's identifiers, which the bound VM supplies. */
export interface RedeployVirtualMachineRequest extends Omit<
  compute.RedeployVirtualMachineRequest,
  "subscriptionId" | "resourceGroupName" | "vmName"
> {}

/**
 * Move a virtual machine to a new Azure host and power it back on. Azure
 * accepts the request and redeploys the VM in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeVirtualMachineRedeployRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachines/redeploy/action`, on the VM only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes VMs, disks, and NICs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RedeployVirtualMachineHttp}.
 *
 * ### Calling RedeployVirtualMachine
 * **Example:** RedeployVirtualMachine from a Function
 * ```typescript
 * const Vm = Azure.Compute.VirtualMachine("Vm", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vm = yield* Vm;
 *     const redeploy = yield* Azure.Compute.RedeployVirtualMachine(vm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* redeploy();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.RedeployVirtualMachineHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface RedeployVirtualMachine extends Binding.Service<
  RedeployVirtualMachine,
  "Azure.Compute.RedeployVirtualMachine",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request?: RedeployVirtualMachineRequest,
    ) => Effect.Effect<
      compute.RedeployVirtualMachineResponse,
      compute.RedeployVirtualMachineError,
      RuntimeContext
    >
  >
> {}

export const RedeployVirtualMachine = Binding.Service<RedeployVirtualMachine>(
  "Azure.Compute.RedeployVirtualMachine",
);
