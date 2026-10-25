import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeVirtualMachineActionBinding, ComputeRole } from "./BindingHttp.ts";
import { PowerOffVirtualMachine } from "./PowerOffVirtualMachine.ts";

/**
 * Implementation of {@link PowerOffVirtualMachine} over the distilled `compute` ARM
 * operation `VirtualMachinesPowerOff`. Assigns the custom `AzureComputeVirtualMachinePowerOffRole` on the
 * VM.
 *
 * @layer
 * @provides Azure.Compute.PowerOffVirtualMachine
 */
export const PowerOffVirtualMachineHttp = Layer.effect(
  PowerOffVirtualMachine,
  makeVirtualMachineActionBinding({
    tag: "Azure.Compute.PowerOffVirtualMachine",
    operation: compute.VirtualMachinesPowerOff,
    grant: ComputeRole.VirtualMachinePowerOff,
  }),
);
