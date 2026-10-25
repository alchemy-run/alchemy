import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeVirtualMachineActionBinding, ComputeRole } from "./BindingHttp.ts";
import { StartVirtualMachine } from "./StartVirtualMachine.ts";

/**
 * Implementation of {@link StartVirtualMachine} over the distilled `compute` ARM
 * operation `StartVirtualMachine`. Assigns the custom `AzureComputeVirtualMachineStartRole` on the
 * VM.
 *
 * @layer
 * @provides Azure.Compute.StartVirtualMachine
 */
export const StartVirtualMachineHttp = Layer.effect(
  StartVirtualMachine,
  makeVirtualMachineActionBinding({
    tag: "Azure.Compute.StartVirtualMachine",
    operation: compute.StartVirtualMachine,
    grant: ComputeRole.VirtualMachineStart,
  }),
);
