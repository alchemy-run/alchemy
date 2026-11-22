import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeScaleSetActionBinding, ComputeRole } from "./BindingHttp.ts";
import { RestartVirtualMachineScaleSet } from "./RestartVirtualMachineScaleSet.ts";

/**
 * Implementation of {@link RestartVirtualMachineScaleSet} over the distilled `compute` ARM
 * operation `RestartVirtualMachineScaleSet`. Assigns the custom `AzureComputeScaleSetRestartRole` on the
 * scale set.
 *
 * @layer
 * @provides Azure.Compute.RestartVirtualMachineScaleSet
 */
export const RestartVirtualMachineScaleSetHttp = Layer.effect(
  RestartVirtualMachineScaleSet,
  makeScaleSetActionBinding({
    tag: "Azure.Compute.RestartVirtualMachineScaleSet",
    operation: compute.RestartVirtualMachineScaleSet,
    grant: ComputeRole.ScaleSetRestart,
  }),
);
