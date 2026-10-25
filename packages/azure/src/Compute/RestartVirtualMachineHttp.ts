import * as compute from "@distilled.cloud/azure/compute";
import * as Layer from "effect/Layer";
import { makeVirtualMachineActionBinding, ComputeRole } from "./BindingHttp.ts";
import { RestartVirtualMachine } from "./RestartVirtualMachine.ts";

/**
 * Implementation of {@link RestartVirtualMachine} over the distilled `compute` ARM
 * operation `RestartVirtualMachine`. Assigns the custom `AzureComputeVirtualMachineRestartRole` on the
 * VM.
 *
 * @layer
 * @provides Azure.Compute.RestartVirtualMachine
 */
export const RestartVirtualMachineHttp = Layer.effect(
  RestartVirtualMachine,
  makeVirtualMachineActionBinding({
    tag: "Azure.Compute.RestartVirtualMachine",
    operation: compute.RestartVirtualMachine,
    grant: ComputeRole.VirtualMachineRestart,
  }),
);
