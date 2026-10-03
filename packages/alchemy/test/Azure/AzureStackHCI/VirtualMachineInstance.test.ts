import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
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
  hci.GetVirtualMachineInstance({ resourceUri: machineId });

// Inputs on a subscription with an Azure Local cluster: an Arc machine
// record (kind HCI) for the VM, a gallery image, and a network interface.
const vmMachineId = () => process.env.AZURE_TEST_HCI_VM_MACHINE ?? "";
const imageId = () => process.env.AZURE_TEST_HCI_IMAGE ?? "";
const nicId = () => process.env.AZURE_TEST_HCI_NIC ?? "";

const program = (props: { memoryMB: number; computerName: string }) =>
  Effect.gen(function* () {
    const vm = yield* Azure.AzureStackHCI.VirtualMachineInstance("Vm", {
      machineId: vmMachineId(),
      extendedLocation: { name: customLocationId() },
      hardwareProfile: {
        vmSize: "Custom",
        processors: 2,
        memoryMB: props.memoryMB,
      },
      imageId: imageId(),
      networkInterfaceIds: [nicId()],
      osProfile: {
        computerName: props.computerName,
        adminUsername: "azureuser",
        adminPassword: process.env.AZURE_TEST_HCI_VM_PASSWORD,
      },
    });
    return { vm };
  });

// Runs a VM on a deployed Azure Local cluster (impossible on the free
// trial). Run with AZURE_TEST_PAID=1, AZURE_TEST_HCI_CUSTOM_LOCATION,
// AZURE_TEST_HCI_VM_MACHINE, AZURE_TEST_HCI_IMAGE, AZURE_TEST_HCI_NIC and
// AZURE_TEST_HCI_VM_PASSWORD.
test.provider.skipIf(!runPaidOnly)(
  "create, resize, replace, and delete an Arc VM",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vm } = yield* stack.deploy(
        program({ memoryMB: 4096, computerName: "alchemy-a" }),
      );
      const observed = yield* getInstance(vmMachineId());
      expect(observed.properties?.hardwareProfile?.memoryMB).toEqual(4096);

      // In place: resize.
      const resized = yield* stack.deploy(
        program({ memoryMB: 8192, computerName: "alchemy-a" }),
      );
      expect(resized.vm.vmId).toEqual(vm.vmId);
      const reobserved = yield* getInstance(vmMachineId());
      expect(reobserved.properties?.hardwareProfile?.memoryMB).toEqual(8192);

      // Replacement: the OS profile is immutable.
      const replaced = yield* stack.deploy(
        program({ memoryMB: 8192, computerName: "alchemy-b" }),
      );
      expect(replaced.vm.vmId).not.toEqual(vm.vmId);

      yield* stack.destroy();
      expect(yield* waitGone(getInstance(vmMachineId()))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): on a bare Arc machine record created out of band,
// a missing custom location rejects the VM with the typed error.
test.provider(
  "a missing custom location rejects an Arc VM with a typed error",
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
      yield* withArcMachineRecord(group.resourceGroupName, (machineId) =>
        Effect.gen(function* () {
          const error = yield* hci
            .VirtualMachineInstancesCreateOrUpdate({
              resourceUri: machineId,
              extendedLocation: {
                type: "CustomLocation",
                name: missingCustomLocation(
                  subscriptionId,
                  group.resourceGroupName,
                ),
              },
              properties: { hardwareProfile: { vmSize: "Default" } },
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
