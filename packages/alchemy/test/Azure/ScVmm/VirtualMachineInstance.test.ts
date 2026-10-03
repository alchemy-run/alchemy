import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as scvmm from "@distilled.cloud/azure/scvmm";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  customLocationId,
  logLevel,
  missingCustomLocation,
  subscription,
  tags,
  waitGone,
  withArcMachineRecord,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getInstance = (machineId: string) =>
  scvmm.GetVirtualMachineInstance({ resourceUri: machineId });

// Inputs on a subscription with an Arc-enabled SCVMM: the VMM server, an
// SCVMM cloud and VM template onboarded into Azure.
const vmmServerId = () => process.env.AZURE_TEST_SCVMM_VMM_SERVER ?? "";
const cloudId = () => process.env.AZURE_TEST_SCVMM_CLOUD ?? "";
const templateId = () => process.env.AZURE_TEST_SCVMM_TEMPLATE ?? "";

const program = (props: { memoryMB: number; computerName: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const machine = yield* Azure.HybridCompute.Machine("Machine", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      kind: "SCVMM",
    });
    const vm = yield* Azure.ScVmm.VirtualMachineInstance("Vm", {
      machineId: machine.machineId,
      extendedLocation: { name: customLocationId() },
      infrastructureProfile: {
        vmmServerId: vmmServerId(),
        cloudId: cloudId(),
        templateId: templateId(),
      },
      osProfile: { computerName: props.computerName },
      hardwareProfile: { cpuCount: 2, memoryMB: props.memoryMB },
      deleteFromHost: true,
    });
    return { machine, vm };
  });

// Deploys a VM on an on-premises SCVMM behind an Arc resource bridge
// (impossible on the free trial). Run with AZURE_TEST_PAID=1,
// AZURE_TEST_SCVMM_CUSTOM_LOCATION, AZURE_TEST_SCVMM_VMM_SERVER,
// AZURE_TEST_SCVMM_CLOUD and AZURE_TEST_SCVMM_TEMPLATE.
test.provider.skipIf(!runPaidOnly)(
  "create, resize, replace, and delete an SCVMM VM",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { machine, vm } = yield* stack.deploy(
        program({ memoryMB: 4096, computerName: "alchemy-a" }),
      );
      const observed = yield* getInstance(machine.machineId);
      expect(observed.properties?.hardwareProfile?.memoryMB).toEqual(4096);

      // In place: resize.
      const resized = yield* stack.deploy(
        program({ memoryMB: 8192, computerName: "alchemy-a" }),
      );
      expect(resized.vm.uuid).toEqual(vm.uuid);
      const reobserved = yield* getInstance(machine.machineId);
      expect(reobserved.properties?.hardwareProfile?.memoryMB).toEqual(8192);

      // Replacement: the OS profile is immutable.
      const replaced = yield* stack.deploy(
        program({ memoryMB: 8192, computerName: "alchemy-b" }),
      );
      expect(replaced.vm.uuid).not.toEqual(vm.uuid);

      yield* stack.destroy();
      expect(yield* waitGone(getInstance(machine.machineId))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): on a bare Arc machine record created out of band,
// a missing custom location rejects the VM with the typed error.
test.provider(
  "a missing custom location rejects an SCVMM VM with a typed error",
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
      yield* ensureRegistered(subscriptionId, "Microsoft.ScVmm");
      yield* withArcMachineRecord(group.resourceGroupName, (machineId) =>
        Effect.gen(function* () {
          const error = yield* scvmm
            .VirtualMachineInstancesCreateOrUpdate({
              resourceUri: machineId,
              extendedLocation: {
                type: "CustomLocation",
                name: missingCustomLocation(
                  subscriptionId,
                  group.resourceGroupName,
                ),
              },
              properties: { hardwareProfile: { cpuCount: 1 } },
            })
            .pipe(Effect.flip);
          expect(error._tag).toEqual("CustomLocationNotFound");
          const getError = yield* getInstance(machineId).pipe(Effect.flip);
          expect(getError._tag).toEqual("ResourceNotFound");
        }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
