import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeVirtualMachineActionBinding, ComputeRole } from "./BindingHttp.ts";
import { DeallocateVirtualMachine } from "./DeallocateVirtualMachine.ts";

/**
 * Implementation of {@link DeallocateVirtualMachine} over the distilled `compute` ARM
 * operation `VirtualMachinesDeallocate`. Assigns the custom `AzureComputeVirtualMachineDeallocateRole` on the
 * VM.
 *
 * @layer
 * @provides Azure.Compute.DeallocateVirtualMachine
 */
export const DeallocateVirtualMachineHttp = Layer.effect(
  DeallocateVirtualMachine,
  makeVirtualMachineActionBinding({
    tag: "Azure.Compute.DeallocateVirtualMachine",
    operation: compute.VirtualMachinesDeallocate,
    grant: ComputeRole.VirtualMachineDeallocate,
  }),
);
