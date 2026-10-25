import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Layer from "effect/Layer";
import { DevTestLabsRole, makeLabVirtualMachineActionBinding } from "./BindingHttp.ts";
import { RedeployVirtualMachine } from "./RedeployVirtualMachine.ts";

/**
 * Implementation of {@link RedeployVirtualMachine} over the distilled `devtestlabs` ARM
 * API. Assigns the custom `AzureDevTestLabsRedeployVirtualMachineRole` on the lab VM.
 *
 * @layer
 * @provides Azure.DevTestLabs.RedeployVirtualMachine
 */
export const RedeployVirtualMachineHttp = Layer.effect(
  RedeployVirtualMachine,
  makeLabVirtualMachineActionBinding({
    tag: "Azure.DevTestLabs.RedeployVirtualMachine",
    operation: devtestlabs.RedeployVirtualMachine,
    role: DevTestLabsRole.RedeployVirtualMachine,
  }),
);
