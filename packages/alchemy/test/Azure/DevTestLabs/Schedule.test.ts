import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  PUBLIC_KEY_1,
  VM_LOCATION,
  VM_SIZE,
  vmNetwork,
} from "../Compute/helpers.ts";
import { withVcpus } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchedule = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetGlobalSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      name,
    });
  });

const program = (props: { time: string; status: "Enabled" | "Disabled" }) =>
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
    const schedule = yield* Azure.DevTestLabs.Schedule("Shutdown", {
      resourceGroup: group.resourceGroupName,
      location: vm.location,
      targetResourceId: vm.virtualMachineId,
      dailyRecurrence: { time: props.time },
      status: props.status,
      timeZoneId: "UTC",
      notificationSettings: { status: "Disabled", timeInMinutes: 30 },
    });
    return { group, vm, schedule };
  });

// One 1-vCPU VM (~$0.04/hour) for ~10 minutes; the schedule is free.
test.provider(
  "create, update, and delete a VM auto-shutdown schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, schedule } = yield* stack.deploy(
        program({ time: "1900", status: "Enabled" }),
      );
      expect(schedule.scheduleName).toEqual(
        `shutdown-computevm-${vm.virtualMachineName}`,
      );
      const get = () =>
        getSchedule(group.resourceGroupName, schedule.scheduleName);
      const observed = yield* get();
      expect(observed.properties?.taskType).toEqual("ComputeVmShutdownTask");
      expect(observed.properties?.dailyRecurrence?.time).toEqual("1900");
      expect(observed.properties?.targetResourceId?.toLowerCase()).toEqual(
        vm.virtualMachineId.toLowerCase(),
      );

      // In-place: time + status.
      const updated = yield* stack.deploy(
        program({ time: "2100", status: "Disabled" }),
      );
      expect(updated.schedule.scheduleId).toEqual(schedule.scheduleId);
      const reobserved = yield* get();
      expect(reobserved.properties?.dailyRecurrence?.time).toEqual("2100");
      expect(reobserved.properties?.status).toEqual("Disabled");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
