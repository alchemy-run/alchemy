import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeScaleSetActionBinding, ComputeRole } from "./BindingHttp.ts";
import { StartVirtualMachineScaleSet } from "./StartVirtualMachineScaleSet.ts";

/**
 * Implementation of {@link StartVirtualMachineScaleSet} over the distilled `compute` ARM
 * operation `StartVirtualMachineScaleSet`. Assigns the custom `AzureComputeScaleSetStartRole` on the
 * scale set.
 *
 * @layer
 * @provides Azure.Compute.StartVirtualMachineScaleSet
 */
export const StartVirtualMachineScaleSetHttp = Layer.effect(
  StartVirtualMachineScaleSet,
  makeScaleSetActionBinding({
    tag: "Azure.Compute.StartVirtualMachineScaleSet",
    operation: compute.StartVirtualMachineScaleSet,
    grant: ComputeRole.ScaleSetStart,
  }),
);
