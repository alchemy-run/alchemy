import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withVcpus } from "../gates.ts";
import {
  logLevel,
  PUBLIC_KEY_1,
  SCSI_VM_SIZE,
  subscriptionId,
  tags,
  untilGone,
  VM_LOCATION,
  vmNetwork,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPoint = (
  resourceGroupName: string,
  restorePointCollectionName: string,
  restorePointName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetRestorePoint({
      subscriptionId,
      resourceGroupName,
      restorePointCollectionName,
      restorePointName,
    }),
  );

// One 2-vCPU SCSI VM (~$0.10/hour) for ~10 minutes plus incremental
// snapshots of a 30 GiB OS disk for minutes: well under $0.10 per run.
const program = (props: { consistencyMode?: "CrashConsistent" }) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork();
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: SCSI_VM_SIZE,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY_1],
    });
    const collection = yield* Azure.Compute.RestorePointCollection("Points", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      sourceVirtualMachineId: vm.virtualMachineId,
    });
    const point = yield* Azure.Compute.RestorePoint("Snapshot", {
      resourceGroup: group.resourceGroupName,
      restorePointCollection: collection.restorePointCollectionName,
      consistencyMode: props.consistencyMode,
    });
    return { group, vm, collection, point };
  });

test.provider(
  "create, replace, and delete a restore point",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, collection, point } = yield* stack.deploy(
        program({ consistencyMode: "CrashConsistent" }),
      );
      expect(point.provisioningState).toEqual("Succeeded");
      expect(point.consistencyMode).toEqual("CrashConsistent");
      const observed = yield* getPoint(
        group.resourceGroupName,
        collection.restorePointCollectionName,
        point.restorePointName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // Restore points are immutable: a new consistency mode takes a new one.
      const replaced = yield* stack.deploy(program({}));
      expect(replaced.point.restorePointName).not.toEqual(
        point.restorePointName,
      );
      expect(
        yield* untilGone(
          getPoint(
            group.resourceGroupName,
            collection.restorePointCollectionName,
            point.restorePointName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPoint(
            group.resourceGroupName,
            collection.restorePointCollectionName,
            replaced.point.restorePointName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 900_000 },
);
