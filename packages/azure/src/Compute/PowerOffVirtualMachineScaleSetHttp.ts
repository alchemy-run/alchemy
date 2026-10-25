import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeScaleSetActionBinding, ComputeRole } from "./BindingHttp.ts";
import { PowerOffVirtualMachineScaleSet } from "./PowerOffVirtualMachineScaleSet.ts";

/**
 * Implementation of {@link PowerOffVirtualMachineScaleSet} over the distilled `compute` ARM
 * operation `VirtualMachineScaleSetsPowerOff`. Assigns the custom `AzureComputeScaleSetPowerOffRole` on the
 * scale set.
 *
 * @layer
 * @provides Azure.Compute.PowerOffVirtualMachineScaleSet
 */
export const PowerOffVirtualMachineScaleSetHttp = Layer.effect(
  PowerOffVirtualMachineScaleSet,
  makeScaleSetActionBinding({
    tag: "Azure.Compute.PowerOffVirtualMachineScaleSet",
    operation: compute.VirtualMachineScaleSetsPowerOff,
    grant: ComputeRole.ScaleSetPowerOff,
  }),
);
