import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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

const getImage = (resourceGroupName: string, imageName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetImage({ subscriptionId, resourceGroupName, imageName }),
  );

/** Deallocate and generalize the source VM out of band. */
const generalize = (resourceGroupName: string, vmName: string) =>
  Effect.gen(function* () {
    const id = yield* subscriptionId;
    const where = { subscriptionId: id, resourceGroupName, vmName };
    yield* compute.VirtualMachinesDeallocate(where);
    yield* compute.VirtualMachinesInstanceView(where).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (view) =>
          (view.statuses ?? []).some(
            (status) => status.code === "PowerState/deallocated",
          ),
        times: 36,
      }),
    );
    yield* compute.VirtualMachinesGeneralize(where);
  });

// One 1-vCPU VM (~$0.04/hour) for ~10 minutes plus a 30 GiB managed image
// (~$0.05/GB-month, minutes): well under $0.05 per run.
const program = (props: { withImage: boolean; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork();
    const vm = yield* Azure.Compute.VirtualMachine("Source", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      // Managed images cannot capture Trusted Launch VMs.
      securityType: "Standard",
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY_1],
    });
    const image = props.withImage
      ? yield* Azure.Compute.Image("Golden", {
          resourceGroup: group.resourceGroupName,
          location: VM_LOCATION,
          sourceVirtualMachineId: vm.virtualMachineId,
          hyperVGeneration: "V2",
          tags: props.tags,
        })
      : undefined;
    return { group, vm, image };
  });

test.provider(
  "capture, update, and delete a managed image",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm } = yield* stack.deploy(
        program({ withImage: false, tags: {} }),
      );
      yield* generalize(group.resourceGroupName, vm.virtualMachineName);

      const { image } = yield* stack.deploy(
        program({ withImage: true, tags: { env: "test" } }),
      );
      expect(image).toBeDefined();
      expect(image!.osType).toEqual("Linux");
      expect(image!.hyperVGeneration).toEqual("V2");
      expect(image!.sourceVirtualMachineId?.toLowerCase()).toEqual(
        vm.virtualMachineId.toLowerCase(),
      );
      const observed = yield* getImage(
        group.resourceGroupName,
        image!.imageName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Golden");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ withImage: true, tags: { env: "prod" } }),
      );
      expect(updated.image!.imageId).toEqual(image!.imageId);
      const reobserved = yield* getImage(
        group.resourceGroupName,
        image!.imageName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getImage(group.resourceGroupName, image!.imageName)),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
