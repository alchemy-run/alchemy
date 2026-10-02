import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
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

const getCollection = (
  resourceGroupName: string,
  restorePointCollectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetRestorePointCollection({
      subscriptionId,
      resourceGroupName,
      restorePointCollectionName,
    }),
  );

// One 1-vCPU VM (~$0.04/hour) for ~10 minutes; the collection is free.
const program = (props: { tags: Record<string, string> }) =>
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
    const collection = yield* Azure.Compute.RestorePointCollection("Points", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      sourceVirtualMachineId: vm.virtualMachineId,
      tags: props.tags,
    });
    return { group, vm, collection };
  });

test.provider(
  "create, update, and delete a restore point collection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, collection } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(collection.sourceVirtualMachineId?.toLowerCase()).toEqual(
        vm.virtualMachineId.toLowerCase(),
      );
      expect(collection.restorePointCollectionId).toBeDefined();
      const observed = yield* getCollection(
        group.resourceGroupName,
        collection.restorePointCollectionName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Points");

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.collection.restorePointCollectionResourceId).toEqual(
        collection.restorePointCollectionResourceId,
      );
      const reobserved = yield* getCollection(
        group.resourceGroupName,
        collection.restorePointCollectionName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getCollection(
            group.resourceGroupName,
            collection.restorePointCollectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
