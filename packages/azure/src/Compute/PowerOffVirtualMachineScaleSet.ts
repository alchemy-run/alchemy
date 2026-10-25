import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachineScaleSet } from "./VirtualMachineScaleSet.ts";

/** `VirtualMachineScaleSetsPowerOff` request without the scale set's identifiers, which the bound scale set supplies. */
export interface PowerOffVirtualMachineScaleSetRequest extends Omit<
  compute.VirtualMachineScaleSetsPowerOffRequest,
  "subscriptionId" | "resourceGroupName" | "vmScaleSetName"
> {}

/**
 * Power off the VMs of a virtual machine scale set (all of them, or the
 * `instanceIds` given). They keep their compute allocation and are still
 * billed. Azure accepts the request and stops them in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeScaleSetPowerOffRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachineScaleSets/powerOff/action`, on the scale set only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes scale sets and VMs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PowerOffVirtualMachineScaleSetHttp}.
 *
 * ### Calling PowerOffVirtualMachineScaleSet
 * **Example:** PowerOffVirtualMachineScaleSet from a Function
 * ```typescript
 * const Workers = Azure.Compute.VirtualMachineScaleSet("Workers", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workers = yield* Workers;
 *     const powerOff = yield* Azure.Compute.PowerOffVirtualMachineScaleSet(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* powerOff({ instanceIds: ["0"] });
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.PowerOffVirtualMachineScaleSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface PowerOffVirtualMachineScaleSet extends Binding.Service<
  PowerOffVirtualMachineScaleSet,
  "Azure.Compute.PowerOffVirtualMachineScaleSet",
  (
    scaleSet: VirtualMachineScaleSet,
  ) => Effect.Effect<
    (
      request?: PowerOffVirtualMachineScaleSetRequest,
    ) => Effect.Effect<
      compute.VirtualMachineScaleSetsPowerOffResponse,
      compute.VirtualMachineScaleSetsPowerOffError,
      RuntimeContext
    >
  >
> {}

export const PowerOffVirtualMachineScaleSet = Binding.Service<PowerOffVirtualMachineScaleSet>(
  "Azure.Compute.PowerOffVirtualMachineScaleSet",
);
