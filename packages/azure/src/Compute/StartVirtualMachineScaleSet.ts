import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachineScaleSet } from "./VirtualMachineScaleSet.ts";

/** `StartVirtualMachineScaleSet` request without the scale set's identifiers, which the bound scale set supplies. */
export interface StartVirtualMachineScaleSetRequest extends Omit<
  compute.StartVirtualMachineScaleSetRequest,
  "subscriptionId" | "resourceGroupName" | "vmScaleSetName"
> {}

/**
 * Start the VMs of a virtual machine scale set (all of them, or the
 * `instanceIds` given). Azure accepts the request and starts them in the
 * background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeScaleSetStartRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachineScaleSets/start/action`, on the scale set only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes scale sets and VMs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartVirtualMachineScaleSetHttp}.
 *
 * ### Calling StartVirtualMachineScaleSet
 * **Example:** StartVirtualMachineScaleSet from a Function
 * ```typescript
 * const Workers = Azure.Compute.VirtualMachineScaleSet("Workers", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workers = yield* Workers;
 *     const start = yield* Azure.Compute.StartVirtualMachineScaleSet(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* start();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.StartVirtualMachineScaleSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface StartVirtualMachineScaleSet extends Binding.Service<
  StartVirtualMachineScaleSet,
  "Azure.Compute.StartVirtualMachineScaleSet",
  (
    scaleSet: VirtualMachineScaleSet,
  ) => Effect.Effect<
    (
      request?: StartVirtualMachineScaleSetRequest,
    ) => Effect.Effect<
      compute.StartVirtualMachineScaleSetResponse,
      compute.StartVirtualMachineScaleSetError,
      RuntimeContext
    >
  >
> {}

export const StartVirtualMachineScaleSet = Binding.Service<StartVirtualMachineScaleSet>(
  "Azure.Compute.StartVirtualMachineScaleSet",
);
