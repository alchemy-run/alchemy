import * as Azure from "@alchemy.run/azure";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  bogusCustomLocation,
  customLocationId,
  hasWorkloadNetworks,
  logLevel,
  nexus,
  sshKey,
  subscription,
  tags,
  waitGone,
  workloadNetworks,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetVirtualMachine({
      subscriptionId: yield* subscription,
      resourceGroupName,
      virtualMachineName: name,
    });
  });

const program = (props: { cpuCores: number; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const { csn, l3 } = yield* workloadNetworks(group.resourceGroupName, 1024);
    const res = yield* Azure.NetworkCloud.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId,
      adminUsername: "azureuser",
      cloudServicesNetworkAttachment: {
        attachedNetworkId: csn.cloudServicesNetworkId,
        ipAllocationMethod: "Dynamic",
      },
      networkAttachments: [
        {
          attachedNetworkId: l3.l3NetworkId,
          ipAllocationMethod: "Dynamic",
          defaultGateway: "True",
        },
      ],
      cpuCores: props.cpuCores,
      memorySizeGB: 4,
      storageProfile: { osDisk: { diskSizeGB: 64 } },
      vmImage: nexus.vmImage,
      sshPublicKeys: [sshKey],
      tags: { env: props.env },
    });
    return { group, res };
  });

// Billed as part of the Nexus cluster; 20-40 min (a VM and its
// replacement). Needs a deployed Operator Nexus cluster on certified
// on-premises racks (AZURE_NEXUS_CUSTOM_LOCATION_ID,
// AZURE_NEXUS_L3_ISOLATION_DOMAIN_ID, AZURE_NEXUS_VM_IMAGE).
test.provider.skipIf(!runPaidOnly || !hasWorkloadNetworks || !nexus.vmImage)(
  "create, update, replace, and delete a Nexus virtual machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program({ cpuCores: 2, env: "a" }));
      const observed = yield* get(group.resourceGroupName, res.virtualMachineName);
      expect(observed.properties.cpuCores).toEqual(2);
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(program({ cpuCores: 2, env: "b" }));
      expect(updated.res.virtualMachineId).toEqual(res.virtualMachineId);
      const reobserved = yield* get(group.resourceGroupName, res.virtualMachineName);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement (the CPU count is immutable).
      const replaced = yield* stack.deploy(program({ cpuCores: 4, env: "b" }));
      expect(replaced.res.virtualMachineName).not.toEqual(res.virtualMachineName);
      expect(yield* waitGone(get(group.resourceGroupName, res.virtualMachineName))).toEqual(
        "gone",
      );
      const final = yield* get(group.resourceGroupName, replaced.res.virtualMachineName);
      expect(final.properties.cpuCores).toEqual(4);

      yield* stack.destroy();
      expect(
        yield* waitGone(get(group.resourceGroupName, replaced.res.virtualMachineName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 5_400_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus virtual machine without a cluster custom location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const resourceGroupName = group.resourceGroupName;
      const pre = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers`;
      const error = yield* nc
        .VirtualMachinesCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          virtualMachineName: "probe",
          extendedLocation: bogusCustomLocation(subscriptionId, resourceGroupName),
          properties: {
            adminUsername: "azureuser",
            cloudServicesNetworkAttachment: {
              attachedNetworkId: `${pre}/Microsoft.NetworkCloud/cloudServicesNetworks/nocsn`,
              ipAllocationMethod: "Dynamic",
            },
            cpuCores: 2,
            memorySizeGB: 4,
            storageProfile: { osDisk: { diskSizeGB: 64 } },
            vmImage: "example.azurecr.io/image:latest",
            sshPublicKeys: [sshKey],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
