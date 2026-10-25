import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeScaleSetActionBinding, ComputeRole } from "./BindingHttp.ts";
import { RedeployVirtualMachineScaleSet } from "./RedeployVirtualMachineScaleSet.ts";

/**
 * Implementation of {@link RedeployVirtualMachineScaleSet} over the distilled `compute` ARM
 * operation `RedeployVirtualMachineScaleSet`. Assigns the custom `AzureComputeScaleSetRedeployRole` on the
 * scale set.
 *
 * @layer
 * @provides Azure.Compute.RedeployVirtualMachineScaleSet
 */
export const RedeployVirtualMachineScaleSetHttp = Layer.effect(
  RedeployVirtualMachineScaleSet,
  makeScaleSetActionBinding({
    tag: "Azure.Compute.RedeployVirtualMachineScaleSet",
    operation: compute.RedeployVirtualMachineScaleSet,
    grant: ComputeRole.ScaleSetRedeploy,
  }),
);
