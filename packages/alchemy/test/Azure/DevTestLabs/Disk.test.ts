import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { PUBLIC_KEY_1 } from "../Compute/helpers.ts";
import { runExpensive, withVcpus } from "../gates.ts";
import {
  caller,
  LAB_VM_SIZE,
  labNetworkFixture,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDisk = (
  resourceGroupName: string,
  labName: string,
  userName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetDisk({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      userName,
      name,
    });
  });

const program = (props: { sizeGiB: number; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { oid, tid } = yield* caller;
    const { group, lab, subnet, network } = yield* labNetworkFixture();
    const user = yield* Azure.DevTestLabs.User("LabUser", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      objectId: oid,
      tenantId: tid,
    });
    const vm = yield* Azure.DevTestLabs.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      size: LAB_VM_SIZE,
      galleryImageReference: {
        publisher: "Canonical",
        offer: "0001-com-ubuntu-server-jammy",
        sku: "22_04-lts-gen2",
        osType: "Linux",
      },
      userName: "azureuser",
      isAuthenticationWithSshKey: true,
      sshKey: PUBLIC_KEY_1,
      labVirtualNetworkId: network.labVirtualNetworkId,
      labSubnetName: subnet.subnetName,
      disallowPublicIpAddress: true,
      storageType: "Standard",
    });
    // Azure fails standalone empty lab disks (provisioningState 'Failed'
    // with no detail), so the disk is created attached to a lab VM.
    const disk = yield* Azure.DevTestLabs.Disk("Data", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      user: user.userName,
      diskType: "Standard",
      diskSizeGiB: props.sizeGiB,
      leasedByLabVmId: vm.virtualMachineId,
      tags: props.tags,
    });
    return { group, lab, user, vm, disk };
  });

// One 2-vCPU lab VM (~$0.10/hour) + a 4-8 GiB standard disk for ~25
// minutes: ~$0.05. Gated: the lab VM alone takes ~5 minutes to create and
// ~5 to delete, so the lifecycle runs well past 10 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a lab disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, user, vm, disk } = yield* stack.deploy(
        program({ sizeGiB: 4, tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getDisk(group.resourceGroupName, lab.labName, user.userName, name);
      const observed = yield* get(disk.diskName);
      expect(observed.properties?.diskSizeGiB).toEqual(4);
      expect(observed.properties?.diskType).toEqual("Standard");
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.leasedByLabVmId?.toLowerCase()).toEqual(
        vm.virtualMachineId.toLowerCase(),
      );
      expect(disk.managedDiskId).toBeDefined();

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ sizeGiB: 4, tags: { env: "prod" } }),
      );
      expect(updated.disk.diskId).toEqual(disk.diskId);
      expect((yield* get(disk.diskName)).tags?.env).toEqual("prod");

      // Replacement: size.
      const replaced = yield* stack.deploy(
        program({ sizeGiB: 8, tags: { env: "prod" } }),
      );
      expect(replaced.disk.diskName).not.toEqual(disk.diskName);
      expect(
        (yield* get(replaced.disk.diskName)).properties?.diskSizeGiB,
      ).toEqual(8);
      expect(yield* waitGone(get(disk.diskName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.disk.diskName))).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 900_000 },
);
