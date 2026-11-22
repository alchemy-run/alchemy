import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachineScaleSet } from "./VirtualMachineScaleSet.ts";

/** `RestartVirtualMachineScaleSet` request without the scale set's identifiers, which the bound scale set supplies. */
export interface RestartVirtualMachineScaleSetRequest extends Omit<
  compute.RestartVirtualMachineScaleSetRequest,
  "subscriptionId" | "resourceGroupName" | "vmScaleSetName"
> {}

/**
 * Restart the VMs of a virtual machine scale set (all of them, or the
 * `instanceIds` given). Azure accepts the request and restarts them in the
 * background (HTTP 202).
 *
 * Binding assigns a custom role (`AzureComputeScaleSetRestartRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachineScaleSets/restart/action`, on the scale set only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes scale sets and VMs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RestartVirtualMachineScaleSetHttp}.
 *
 * ### Calling RestartVirtualMachineScaleSet
 * **Example:** RestartVirtualMachineScaleSet from a Function
 * ```typescript
 * const Workers = Azure.Compute.VirtualMachineScaleSet("Workers", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workers = yield* Workers;
 *     const restart = yield* Azure.Compute.RestartVirtualMachineScaleSet(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restart();
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.RestartVirtualMachineScaleSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface RestartVirtualMachineScaleSet extends Binding.Service<
  RestartVirtualMachineScaleSet,
  "Azure.Compute.RestartVirtualMachineScaleSet",
  (
    scaleSet: VirtualMachineScaleSet,
  ) => Effect.Effect<
    (
      request?: RestartVirtualMachineScaleSetRequest,
    ) => Effect.Effect<
      compute.RestartVirtualMachineScaleSetResponse,
      compute.RestartVirtualMachineScaleSetError,
      RuntimeContext
    >
  >
> {}

export const RestartVirtualMachineScaleSet = Binding.Service<RestartVirtualMachineScaleSet>(
  "Azure.Compute.RestartVirtualMachineScaleSet",
);
