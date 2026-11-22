import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Layer from "effect/Layer";
import { DevTestLabsRole, makeLabVirtualMachineActionBinding } from "./BindingHttp.ts";
import { RestartVirtualMachine } from "./RestartVirtualMachine.ts";

/**
 * Implementation of {@link RestartVirtualMachine} over the distilled `devtestlabs` ARM
 * API. Assigns the custom `AzureDevTestLabsRestartVirtualMachineRole` on the lab VM.
 *
 * @layer
 * @provides Azure.DevTestLabs.RestartVirtualMachine
 */
export const RestartVirtualMachineHttp = Layer.effect(
  RestartVirtualMachine,
  makeLabVirtualMachineActionBinding({
    tag: "Azure.DevTestLabs.RestartVirtualMachine",
    operation: devtestlabs.RestartVirtualMachine,
    role: DevTestLabsRole.RestartVirtualMachine,
  }),
);
