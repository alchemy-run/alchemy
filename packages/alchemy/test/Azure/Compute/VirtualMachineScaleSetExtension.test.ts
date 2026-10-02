import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { withVcpus } from "../gates.ts";
import {
  logLevel,
  PUBLIC_KEY_1,
  subscriptionId,
  tags,
  untilGone,
  VM_LOCATION,
  VM_SIZE,
  vmNetwork,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getExtension = (
  resourceGroupName: string,
  vmScaleSetName: string,
  vmssExtensionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineScaleSetExtension({
      subscriptionId,
      resourceGroupName,
      vmScaleSetName,
      vmssExtensionName,
    }),
  );

// One 1-vCPU scale set instance (~$0.04/hour) for ~10 minutes.
const program = (props: { timestamp: number }) =>
  Effect.gen(function* () {
    const { group, subnet } = yield* vmNetwork();
    const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("Vmss", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      capacity: 1,
      upgradePolicyMode: "Automatic",
      subnetId: subnet.subnetId,
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY_1],
    });
    const extension = yield* Azure.Compute.VirtualMachineScaleSetExtension(
      "Script",
      {
        resourceGroup: group.resourceGroupName,
        virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
        publisher: "Microsoft.Azure.Extensions",
        type: "CustomScript",
        typeHandlerVersion: "2.1",
        settings: { timestamp: props.timestamp },
        protectedSettings: Redacted.make({ commandToExecute: "echo ok" }),
      },
    );
    return { group, scaleSet, extension };
  });

test.provider(
  "create, update, and delete a scale set extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, scaleSet, extension } = yield* stack.deploy(
        program({ timestamp: 1 }),
      );
      expect(extension.provisioningState).toEqual("Succeeded");
      const observed = yield* getExtension(
        group.resourceGroupName,
        scaleSet.virtualMachineScaleSetName,
        extension.extensionName,
      );
      expect(observed.properties?.type).toEqual("CustomScript");
      expect(observed.properties?.settings).toEqual({ timestamp: 1 });

      // In place: new settings.
      const updated = yield* stack.deploy(program({ timestamp: 2 }));
      expect(updated.extension.extensionId).toEqual(extension.extensionId);
      const reobserved = yield* getExtension(
        group.resourceGroupName,
        scaleSet.virtualMachineScaleSetName,
        extension.extensionName,
      );
      expect(reobserved.properties?.settings).toEqual({ timestamp: 2 });

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getExtension(
            group.resourceGroupName,
            scaleSet.virtualMachineScaleSetName,
            extension.extensionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
