import * as Azure from "@alchemy.run/azure";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { PUBLIC_KEY_1 } from "../Compute/helpers.ts";
import { runExpensive, withVcpus } from "../gates.ts";
import { LAB_VM_SIZE, labNetworkFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getImage = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetCustomImage({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

const program = (props: { name?: string; description: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, lab, subnet, network } = yield* labNetworkFixture();
    const vm = yield* Azure.DevTestLabs.VirtualMachine("Source", {
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
    // Managed images and snapshots alone are rejected by the lab RP ("One
    // of the following properties must be specified: vm, vhd"), so the
    // image is captured from a lab VM.
    const image = yield* Azure.DevTestLabs.CustomImage("Golden", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      name: props.name,
      vm: { sourceVmId: vm.virtualMachineId, linuxOsState: "NonDeprovisioned" },
      description: props.description,
      tags: props.tags,
    });
    return { group, lab, vm, image };
  });

// One 2-vCPU lab VM (~$0.10/hour) for ~35 minutes plus two captured
// 30 GiB images (minutes of storage): ~$0.07. Gated: the lab VM alone takes
// ~5 minutes to create and ~5 to delete, and each capture several more.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a lab custom image",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, vm, image } = yield* stack.deploy(
        program({ description: "Golden", tags: { env: "test" } }),
      );
      const get = (name: string) => getImage(group.resourceGroupName, lab.labName, name);
      const observed = yield* get(image.customImageName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.description).toEqual("Golden");
      expect(observed.properties?.vm?.sourceVmId?.toLowerCase()).toEqual(
        vm.virtualMachineId.toLowerCase(),
      );
      expect(image.managedImageId).toMatch(/\/providers\/Microsoft\.Compute\/images\/[^/]+$/i);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Golden");

      // In-place: description + tags.
      const updated = yield* stack.deploy(
        program({ description: "Golden v2", tags: { env: "prod" } }),
      );
      expect(updated.image.customImageId).toEqual(image.customImageId);
      const reobserved = yield* get(image.customImageName);
      expect(reobserved.properties?.description).toEqual("Golden v2");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-golden-2", description: "Golden v2", tags: { env: "prod" } }),
      );
      expect(replaced.image.customImageName).toEqual("alchemy-golden-2");
      const moved = yield* get(replaced.image.customImageName);
      expect(moved.properties?.provisioningState).toEqual("Succeeded");
      expect(yield* waitGone(get(image.customImageName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.image.customImageName))).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 2_400_000 },
);
