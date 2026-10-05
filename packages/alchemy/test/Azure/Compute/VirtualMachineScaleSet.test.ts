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

const getScaleSet = (resourceGroupName: string, vmScaleSetName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineScaleSet({
      subscriptionId,
      resourceGroupName,
      vmScaleSetName,
    }),
  );

// At most two 1-vCPU instances (~$0.04/hour each) for ~10 minutes.
const program = (props: {
  capacity: number;
  adminUsername: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, subnet } = yield* vmNetwork();
    const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("Vmss", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      capacity: props.capacity,
      subnetId: subnet.subnetId,
      adminUsername: props.adminUsername,
      sshPublicKeys: [PUBLIC_KEY_1],
      tags: props.tags,
    });
    return { group, scaleSet };
  });

test.provider(
  "create, replace, scale, and delete a virtual machine scale set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, scaleSet } = yield* stack.deploy(
        program({
          capacity: 1,
          adminUsername: "azureuser",
          tags: { env: "test" },
        }),
      );
      expect(scaleSet.orchestrationMode).toEqual("Flexible");
      expect(scaleSet.capacity).toEqual(1);
      expect(scaleSet.vmSize).toEqual(VM_SIZE);
      const observed = yield* getScaleSet(
        group.resourceGroupName,
        scaleSet.virtualMachineScaleSetName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Vmss");

      // The admin user is fixed at creation: replacement.
      const replaced = yield* stack.deploy(
        program({
          capacity: 1,
          adminUsername: "operator",
          tags: { env: "test" },
        }),
      );
      expect(replaced.scaleSet.virtualMachineScaleSetName).not.toEqual(
        scaleSet.virtualMachineScaleSetName,
      );
      expect(
        yield* untilGone(
          getScaleSet(
            group.resourceGroupName,
            scaleSet.virtualMachineScaleSetName,
          ),
        ),
      ).toEqual("gone");

      // In place: scale out and change tags.
      const scaled = yield* stack.deploy(
        program({
          capacity: 2,
          adminUsername: "operator",
          tags: { env: "prod" },
        }),
      );
      expect(scaled.scaleSet.virtualMachineScaleSetId).toEqual(
        replaced.scaleSet.virtualMachineScaleSetId,
      );
      expect(scaled.scaleSet.capacity).toEqual(2);
      const reobserved = yield* getScaleSet(
        group.resourceGroupName,
        replaced.scaleSet.virtualMachineScaleSetName,
      );
      expect(reobserved.sku?.capacity).toEqual(2);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getScaleSet(
            group.resourceGroupName,
            replaced.scaleSet.virtualMachineScaleSetName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 900_000 },
);
