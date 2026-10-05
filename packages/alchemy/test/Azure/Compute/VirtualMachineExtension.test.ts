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
  vmName: string,
  vmExtensionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineExtension({
      subscriptionId,
      resourceGroupName,
      vmName,
      vmExtensionName,
    }),
  );

// One 1-vCPU VM (~$0.04/hour) for ~10 minutes; the extension is free.
const program = (props: {
  command: string;
  timestamp: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork();
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY_1],
    });
    const extension = yield* Azure.Compute.VirtualMachineExtension("Script", {
      resourceGroup: group.resourceGroupName,
      virtualMachine: vm.virtualMachineName,
      publisher: "Microsoft.Azure.Extensions",
      type: "CustomScript",
      typeHandlerVersion: "2.1",
      settings: { timestamp: props.timestamp },
      protectedSettings: Redacted.make({ commandToExecute: props.command }),
      tags: props.tags,
    });
    return { group, vm, extension };
  });

test.provider(
  "create, update, and delete a VM extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, extension } = yield* stack.deploy(
        program({ command: "echo one", timestamp: 1, tags: { env: "test" } }),
      );
      expect(extension.provisioningState).toEqual("Succeeded");
      expect(extension.location).toEqual(vm.location);
      const observed = yield* getExtension(
        group.resourceGroupName,
        vm.virtualMachineName,
        extension.extensionName,
      );
      expect(observed.properties?.settings).toEqual({ timestamp: 1 });
      // Protected settings are write-only.
      expect(observed.properties?.protectedSettings).toBeUndefined();
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Script");

      // In place: new timestamp (re-runs the script), new protected command,
      // new tags.
      const updated = yield* stack.deploy(
        program({ command: "echo two", timestamp: 2, tags: { env: "prod" } }),
      );
      expect(updated.extension.extensionId).toEqual(extension.extensionId);
      const reobserved = yield* getExtension(
        group.resourceGroupName,
        vm.virtualMachineName,
        extension.extensionName,
      );
      expect(reobserved.properties?.provisioningState).toEqual("Succeeded");
      expect(reobserved.properties?.settings).toEqual({ timestamp: 2 });
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getExtension(
            group.resourceGroupName,
            vm.virtualMachineName,
            extension.extensionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
