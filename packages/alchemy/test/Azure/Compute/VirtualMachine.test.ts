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
  VM_SIZE_ALT,
  vmNetwork,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVm = (resourceGroupName: string, vmName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachine({ subscriptionId, resourceGroupName, vmName }),
  );

// 1-vCPU F-series v7 VMs (~$0.04/hour) without a public IP for ~10
// minutes: well under $0.05 per run.
const program = (props: {
  vmSize: string;
  adminUsername: string;
  bootDiagnostics: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork();
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: props.vmSize,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: props.adminUsername,
      sshPublicKeys: [PUBLIC_KEY_1],
      bootDiagnostics: props.bootDiagnostics,
      identity: { systemAssigned: props.bootDiagnostics },
      tags: props.tags,
    });
    return { group, nic, vm };
  });

test.provider(
  "create, update, replace, and delete a virtual machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nic, vm } = yield* stack.deploy(
        program({
          vmSize: VM_SIZE,
          adminUsername: "azureuser",
          bootDiagnostics: false,
          tags: { env: "test" },
        }),
      );
      expect(vm.vmId).toMatch(/^[0-9a-f-]{36}$/);
      expect(vm.vmSize).toEqual(VM_SIZE);
      expect(vm.networkInterfaceIds.map((id) => id.toLowerCase())).toEqual([
        nic.networkInterfaceId.toLowerCase(),
      ]);
      expect(vm.principalId).toBeUndefined();
      const observed = yield* getVm(
        group.resourceGroupName,
        vm.virtualMachineName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.osProfile?.adminUsername).toEqual(
        "azureuser",
      );
      expect(
        observed.properties?.osProfile?.linuxConfiguration
          ?.disablePasswordAuthentication,
      ).toEqual(true);
      expect(observed.properties?.storageProfile?.osDisk?.deleteOption).toEqual(
        "Delete",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Vm");

      // In place: resize, boot diagnostics, system identity, tags.
      const updated = yield* stack.deploy(
        program({
          vmSize: VM_SIZE_ALT,
          adminUsername: "azureuser",
          bootDiagnostics: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.vm.vmId).toEqual(vm.vmId);
      expect(updated.vm.vmSize).toEqual(VM_SIZE_ALT);
      expect(updated.vm.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const reobserved = yield* getVm(
        group.resourceGroupName,
        vm.virtualMachineName,
      );
      expect(reobserved.properties?.hardwareProfile?.vmSize).toEqual(
        VM_SIZE_ALT,
      );
      expect(
        reobserved.properties?.diagnosticsProfile?.bootDiagnostics?.enabled,
      ).toEqual(true);
      expect(reobserved.identity?.type).toEqual("SystemAssigned");
      expect(reobserved.tags?.env).toEqual("prod");

      // The admin user is fixed at creation: replacement (delete-first, the
      // NIC is reused).
      const replaced = yield* stack.deploy(
        program({
          vmSize: VM_SIZE_ALT,
          adminUsername: "operator",
          bootDiagnostics: true,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.vm.virtualMachineName).not.toEqual(vm.virtualMachineName);
      expect(replaced.vm.vmId).not.toEqual(vm.vmId);
      const replacedVm = yield* getVm(
        group.resourceGroupName,
        replaced.vm.virtualMachineName,
      );
      expect(replacedVm.properties?.osProfile?.adminUsername).toEqual(
        "operator",
      );
      expect(
        yield* untilGone(getVm(group.resourceGroupName, vm.virtualMachineName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getVm(group.resourceGroupName, replaced.vm.virtualMachineName),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
