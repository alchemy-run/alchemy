import * as Azure from "@alchemy.run/azure";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { withVcpus } from "../gates.ts";
import { logLevel, subscriptionId, tags, uniformScaleSet, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getExtension = (resourceGroupName: string, vmScaleSetName: string, vmExtensionName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineScaleSetVMExtension({
      subscriptionId,
      resourceGroupName,
      vmScaleSetName,
      instanceId: "0",
      vmExtensionName,
    }),
  );

// One 1-vCPU scale set instance (~$0.04/hour) for ~12 minutes.
const program = (props: { timestamp: number }) =>
  Effect.gen(function* () {
    const { group, scaleSet } = yield* uniformScaleSet;
    const extension = yield* Azure.Compute.VirtualMachineScaleSetVMExtension("Script", {
      resourceGroup: group.resourceGroupName,
      virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
      instanceId: "0",
      publisher: "Microsoft.Azure.Extensions",
      type: "CustomScript",
      typeHandlerVersion: "2.1",
      settings: { timestamp: props.timestamp },
      protectedSettings: Redacted.make({ commandToExecute: "echo ok" }),
    });
    return { group, scaleSet, extension };
  });

test.provider(
  "create, update, and delete a scale set VM extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, scaleSet, extension } = yield* stack.deploy(program({ timestamp: 1 }));
      expect(scaleSet.instanceIds).toEqual(["0"]);
      expect(extension.instanceId).toEqual("0");
      expect(extension.provisioningState).toEqual("Succeeded");
      const setName = scaleSet.virtualMachineScaleSetName;
      const observed = yield* getExtension(
        group.resourceGroupName,
        setName,
        extension.extensionName,
      );
      expect(observed.properties?.type).toEqual("CustomScript");
      expect(observed.properties?.settings).toEqual({ timestamp: 1 });

      // In place: new settings re-run the extension.
      const updated = yield* stack.deploy(program({ timestamp: 2 }));
      expect(updated.extension.extensionId).toEqual(extension.extensionId);
      const reobserved = yield* getExtension(
        group.resourceGroupName,
        setName,
        extension.extensionName,
      );
      expect(reobserved.properties?.settings).toEqual({ timestamp: 2 });

      yield* stack.destroy();
      expect(
        yield* untilGone(getExtension(group.resourceGroupName, setName, extension.extensionName)),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
