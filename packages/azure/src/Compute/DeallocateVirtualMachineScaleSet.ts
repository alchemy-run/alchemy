import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachineScaleSet } from "./VirtualMachineScaleSet.ts";

/** `VirtualMachineScaleSetsDeallocate` request without the scale set's identifiers, which the bound scale set supplies. */
export interface DeallocateVirtualMachineScaleSetRequest extends Omit<
  compute.VirtualMachineScaleSetsDeallocateRequest,
  "subscriptionId" | "resourceGroupName" | "vmScaleSetName"
> {}

/**
 * Shut down the VMs of a virtual machine scale set (all of them, or the
 * `instanceIds` given) and release their compute resources. Azure accepts the
 * request and deallocates them in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeScaleSetDeallocateRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachineScaleSets/deallocate/action`, on the scale set only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes scale sets and VMs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeallocateVirtualMachineScaleSetHttp}.
 *
 * ### Calling DeallocateVirtualMachineScaleSet
 * **Example:** DeallocateVirtualMachineScaleSet from a Function
 * ```typescript
 * const Workers = Azure.Compute.VirtualMachineScaleSet("Workers", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workers = yield* Workers;
 *     const deallocate = yield* Azure.Compute.DeallocateVirtualMachineScaleSet(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deallocate();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.DeallocateVirtualMachineScaleSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface DeallocateVirtualMachineScaleSet extends Binding.Service<
  DeallocateVirtualMachineScaleSet,
  "Azure.Compute.DeallocateVirtualMachineScaleSet",
  (
    scaleSet: VirtualMachineScaleSet,
  ) => Effect.Effect<
    (
      request?: DeallocateVirtualMachineScaleSetRequest,
    ) => Effect.Effect<
      compute.VirtualMachineScaleSetsDeallocateResponse,
      compute.VirtualMachineScaleSetsDeallocateError,
      RuntimeContext
    >
  >
> {}

export const DeallocateVirtualMachineScaleSet = Binding.Service<DeallocateVirtualMachineScaleSet>(
  "Azure.Compute.DeallocateVirtualMachineScaleSet",
);
