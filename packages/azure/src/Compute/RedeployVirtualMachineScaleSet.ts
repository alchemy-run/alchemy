import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachineScaleSet } from "./VirtualMachineScaleSet.ts";

/** `RedeployVirtualMachineScaleSet` request without the scale set's identifiers, which the bound scale set supplies. */
export interface RedeployVirtualMachineScaleSetRequest extends Omit<
  compute.RedeployVirtualMachineScaleSetRequest,
  "subscriptionId" | "resourceGroupName" | "vmScaleSetName"
> {}

/**
 * Move the VMs of a virtual machine scale set (all of them, or the
 * `instanceIds` given) to new Azure hosts and power them back on. Azure
 * accepts the request and redeploys them in the background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeScaleSetRedeployRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachineScaleSets/redeploy/action`, on the scale set only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes scale sets and VMs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RedeployVirtualMachineScaleSetHttp}.
 *
 * ### Calling RedeployVirtualMachineScaleSet
 * **Example:** RedeployVirtualMachineScaleSet from a Function
 * ```typescript
 * const Workers = Azure.Compute.VirtualMachineScaleSet("Workers", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workers = yield* Workers;
 *     const redeploy = yield* Azure.Compute.RedeployVirtualMachineScaleSet(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* redeploy();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.RedeployVirtualMachineScaleSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface RedeployVirtualMachineScaleSet extends Binding.Service<
  RedeployVirtualMachineScaleSet,
  "Azure.Compute.RedeployVirtualMachineScaleSet",
  (
    scaleSet: VirtualMachineScaleSet,
  ) => Effect.Effect<
    (
      request?: RedeployVirtualMachineScaleSetRequest,
    ) => Effect.Effect<
      compute.RedeployVirtualMachineScaleSetResponse,
      compute.RedeployVirtualMachineScaleSetError,
      RuntimeContext
    >
  >
> {}

export const RedeployVirtualMachineScaleSet = Binding.Service<RedeployVirtualMachineScaleSet>(
  "Azure.Compute.RedeployVirtualMachineScaleSet",
);
