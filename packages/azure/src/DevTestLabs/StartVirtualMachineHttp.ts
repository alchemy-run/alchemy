import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Layer from "effect/Layer";
import { DevTestLabsRole, makeLabVirtualMachineActionBinding } from "./BindingHttp.ts";
import { StartVirtualMachine } from "./StartVirtualMachine.ts";

/**
 * Implementation of {@link StartVirtualMachine} over the distilled `devtestlabs` ARM
 * API. Assigns the custom `AzureDevTestLabsStartVirtualMachineRole` on the lab VM.
 *
 * @layer
 * @provides Azure.DevTestLabs.StartVirtualMachine
 */
export const StartVirtualMachineHttp = Layer.effect(
  StartVirtualMachine,
  makeLabVirtualMachineActionBinding({
    tag: "Azure.DevTestLabs.StartVirtualMachine",
    operation: devtestlabs.StartVirtualMachine,
    role: DevTestLabsRole.StartVirtualMachine,
  }),
);
