import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeScaleSetActionBinding, ComputeRole } from "./BindingHttp.ts";
import { DeallocateVirtualMachineScaleSet } from "./DeallocateVirtualMachineScaleSet.ts";

/**
 * Implementation of {@link DeallocateVirtualMachineScaleSet} over the distilled `compute` ARM
 * operation `VirtualMachineScaleSetsDeallocate`. Assigns the custom `AzureComputeScaleSetDeallocateRole` on the
 * scale set.
 *
 * @layer
 * @provides Azure.Compute.DeallocateVirtualMachineScaleSet
 */
export const DeallocateVirtualMachineScaleSetHttp = Layer.effect(
  DeallocateVirtualMachineScaleSet,
  makeScaleSetActionBinding({
    tag: "Azure.Compute.DeallocateVirtualMachineScaleSet",
    operation: compute.VirtualMachineScaleSetsDeallocate,
    grant: ComputeRole.ScaleSetDeallocate,
  }),
);
