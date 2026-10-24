import * as Azure from "@alchemy.run/azure";
import * as compute from "@distilled.cloud/azure/compute";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { subscriptionId } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const RG = "AZURE-COMPUTE-VIRTUALMACHINESCALESETVMDIAGNOSTICRUNCOMMADTSDYY5RACUTFIXWOMZDRHFM";
const SET = "Azure-Compute-VirtualMachineScaleSetVMDicnwy6htmz4pmwrmryvo454qy";

test.provider("probe", () =>
  Effect.gen(function* () {
    const id = yield* subscriptionId;
    const base = { subscriptionId: id, resourceGroupName: RG, vmScaleSetName: SET, instanceId: "0" };
    for (const runCommandName of [
      "Azure-Compute-VirtualMachineScaleSetVMDiagnosticRunCommawamcoyil7oac6rdj27owlmau",
      "does-not-exist-probe",
    ]) {
      const get = yield* Effect.result(
        compute.GetVirtualMachineScaleSetVMDiagnosticRunCommand({ ...base, runCommandName }),
      );
      console.log("GET", runCommandName, JSON.stringify(get).slice(0, 800));
      const getRun = yield* Effect.result(
        compute.GetVirtualMachineScaleSetVMRunCommand({ ...base, runCommandName }),
      );
      console.log("GETRUN", runCommandName, JSON.stringify(getRun).slice(0, 800));
      const del = yield* Effect.result(
        compute.DeleteVirtualMachineScaleSetVMDiagnosticRunCommand({ ...base, runCommandName }),
      );
      console.log("DEL", runCommandName, JSON.stringify(del).slice(0, 800));
    }
  }),
);
