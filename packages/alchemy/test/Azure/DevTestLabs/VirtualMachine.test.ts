import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { PUBLIC_KEY_1 } from "../Compute/helpers.ts";
import { runExpensive, withVcpus } from "../gates.ts";
import {
  LAB_VM_SIZE,
  LAB_VM_SIZE_ALT,
  labNetworkFixture,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVm = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetVirtualMachine({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

const program = (props: { size: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, lab, subnet, network } = yield* labNetworkFixture();
    const vm = yield* Azure.DevTestLabs.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      size: props.size,
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
      tags: props.tags,
    });
    return { group, lab, vm };
  });

// One 2-vCPU lab VM (~$0.10/hour) for ~25 minutes: ~$0.05. Gated: the lab
// VM takes ~5 minutes to create, ~10 to resize, and ~5 to delete.
test.provider.skipIf(!runExpensive)(
  "create, resize, retag, and delete a lab VM",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, vm } = yield* stack.deploy(
        program({ size: LAB_VM_SIZE, tags: { env: "test" } }),
      );
      const get = () => getVm(group.resourceGroupName, lab.labName, vm.virtualMachineName);
      const observed = yield* get();
      expect(observed.properties?.size).toEqual(LAB_VM_SIZE);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(vm.computeId).toBeDefined();
      expect(vm.privateIpAddress).toBeDefined();

      // In-place: resize + retag.
      const updated = yield* stack.deploy(
        program({ size: LAB_VM_SIZE_ALT, tags: { env: "prod" } }),
      );
      expect(updated.vm.virtualMachineId).toEqual(vm.virtualMachineId);
      const reobserved = yield* get();
      expect(reobserved.properties?.size).toEqual(LAB_VM_SIZE_ALT);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 1_700_000 },
);
