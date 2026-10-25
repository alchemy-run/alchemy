import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeVirtualMachineActionBinding, ComputeRole } from "./BindingHttp.ts";
import { RedeployVirtualMachine } from "./RedeployVirtualMachine.ts";

/**
 * Implementation of {@link RedeployVirtualMachine} over the distilled `compute` ARM
 * operation `RedeployVirtualMachine`. Assigns the custom `AzureComputeVirtualMachineRedeployRole` on the
 * VM.
 *
 * @layer
 * @provides Azure.Compute.RedeployVirtualMachine
 */
export const RedeployVirtualMachineHttp = Layer.effect(
  RedeployVirtualMachine,
  makeVirtualMachineActionBinding({
    tag: "Azure.Compute.RedeployVirtualMachine",
    operation: compute.RedeployVirtualMachine,
    grant: ComputeRole.VirtualMachineRedeploy,
  }),
);
