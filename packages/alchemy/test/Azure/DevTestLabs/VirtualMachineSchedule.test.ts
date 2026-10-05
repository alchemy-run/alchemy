import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { PUBLIC_KEY_1 } from "../Compute/helpers.ts";
import { runExpensive, withVcpus } from "../gates.ts";
import {
  LAB_VM_SIZE,
  labNetworkFixture,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchedule = (
  resourceGroupName: string,
  labName: string,
  virtualMachineName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetVirtualMachineSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      virtualMachineName,
      name,
    });
  });

const program = (props: { time: string; status: "Enabled" | "Disabled" }) =>
  Effect.gen(function* () {
    const { group, lab, subnet, network } = yield* labNetworkFixture();
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
    const schedule = yield* Azure.DevTestLabs.VirtualMachineSchedule("VmOff", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      virtualMachine: vm.virtualMachineName,
      dailyRecurrence: { time: props.time },
      status: props.status,
    });
    return { group, lab, vm, schedule };
  });

// One 2-vCPU lab VM (~$0.10/hour) for ~15 minutes: ~$0.03. Gated: the lab
// VM takes ~5 minutes to create and ~5 to delete (plus the lab), so the
// lifecycle runs past 10 minutes (measured ~13).
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a lab VM schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, vm, schedule } = yield* stack.deploy(
        program({ time: "2200", status: "Enabled" }),
      );
      expect(schedule.scheduleName).toEqual("LabVmsShutdown");
      const get = () =>
        getSchedule(
          group.resourceGroupName,
          lab.labName,
          vm.virtualMachineName,
          schedule.scheduleName,
        );
      const observed = yield* get();
      expect(observed.properties?.dailyRecurrence?.time).toEqual("2200");
      expect(observed.tags?.["alchemy::id"]).toEqual("VmOff");

      // In-place: time + status.
      const updated = yield* stack.deploy(
        program({ time: "2300", status: "Disabled" }),
      );
      expect(updated.schedule.scheduleId).toEqual(schedule.scheduleId);
      const reobserved = yield* get();
      expect(reobserved.properties?.dailyRecurrence?.time).toEqual("2300");
      expect(reobserved.properties?.status).toEqual("Disabled");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 1_500_000 },
);
