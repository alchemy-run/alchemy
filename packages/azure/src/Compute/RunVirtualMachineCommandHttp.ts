import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeVirtualMachineActionBinding, ComputeRole } from "./BindingHttp.ts";
import { RunVirtualMachineCommand } from "./RunVirtualMachineCommand.ts";

/**
 * Implementation of {@link RunVirtualMachineCommand} over the distilled `compute` ARM
 * operation `RunVirtualMachineCommand`. Assigns the custom `AzureComputeVirtualMachineRunCommandRole` on the
 * VM.
 *
 * @layer
 * @provides Azure.Compute.RunVirtualMachineCommand
 */
export const RunVirtualMachineCommandHttp = Layer.effect(
  RunVirtualMachineCommand,
  makeVirtualMachineActionBinding({
    tag: "Azure.Compute.RunVirtualMachineCommand",
    operation: compute.RunVirtualMachineCommand,
    grant: ComputeRole.VirtualMachineRunCommand,
  }),
);
