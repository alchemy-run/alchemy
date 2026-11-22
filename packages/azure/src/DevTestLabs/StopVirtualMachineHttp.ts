import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Layer from "effect/Layer";
import { DevTestLabsRole, makeLabVirtualMachineActionBinding } from "./BindingHttp.ts";
import { StopVirtualMachine } from "./StopVirtualMachine.ts";

/**
 * Implementation of {@link StopVirtualMachine} over the distilled `devtestlabs` ARM
 * API. Assigns the custom `AzureDevTestLabsStopVirtualMachineRole` on the lab VM.
 *
 * @layer
 * @provides Azure.DevTestLabs.StopVirtualMachine
 */
export const StopVirtualMachineHttp = Layer.effect(
  StopVirtualMachine,
  makeLabVirtualMachineActionBinding({
    tag: "Azure.DevTestLabs.StopVirtualMachine",
    operation: devtestlabs.StopVirtualMachine,
    role: DevTestLabsRole.StopVirtualMachine,
  }),
);
