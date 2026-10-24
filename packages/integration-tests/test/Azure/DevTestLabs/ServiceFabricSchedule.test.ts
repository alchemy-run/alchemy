import * as Azure from "@alchemy.run/azure";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { testCertificate, testNodeTypes } from "../ServiceFabricClassic/util.ts";
import { labUserFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchedule = (
  resourceGroupName: string,
  labName: string,
  userName: string,
  serviceFabricName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetServiceFabricSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      userName,
      serviceFabricName,
      name,
    });
  });

const program = (props: {
  taskType: "LabVmsShutdownTask" | "LabVmsStartupTask";
  time: string;
  status: "Enabled" | "Disabled";
}) =>
  Effect.gen(function* () {
    const { group, lab, user } = yield* labUserFixture();
    // A node-less classic cluster stays in `WaitingForNodes` and is free.
    const cluster = yield* Azure.ServiceFabricClassic.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      reliabilityLevel: "None",
      vmImage: "Windows",
      certificate: testCertificate,
      nodeTypes: testNodeTypes(),
    });
    const fabric = yield* Azure.DevTestLabs.ServiceFabric("Fabric", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      user: user.userName,
      externalServiceFabricId: cluster.clusterResourceId,
    });
    const schedule = yield* Azure.DevTestLabs.ServiceFabricSchedule("FabricOff", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      user: user.userName,
      serviceFabric: fabric.serviceFabricName,
      taskType: props.taskType,
      // Startup schedules only accept a weekly recurrence
      // (`MissingRequiredProperty: WeeklyRecurrence`).
      ...(props.taskType === "LabVmsStartupTask"
        ? { weeklyRecurrence: { weekdays: ["Monday", "Friday"], time: props.time } }
        : { dailyRecurrence: { time: props.time } }),
      status: props.status,
    });
    return { group, lab, user, fabric, schedule };
  });

// A free lab, a lab user, and a node-less classic cluster (free); the lab
// takes 2-5 minutes.
test.provider(
  "create, update, replace, and delete a service fabric schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, user, fabric, schedule } = yield* stack.deploy(
        program({ taskType: "LabVmsShutdownTask", time: "2200", status: "Enabled" }),
      );
      expect(schedule.scheduleName).toEqual("LabVmsShutdown");
      expect(schedule.taskType).toEqual("LabVmsShutdownTask");
      const get = (name: string) =>
        getSchedule(
          group.resourceGroupName,
          lab.labName,
          user.userName,
          fabric.serviceFabricName,
          name,
        );
      const observed = yield* get(schedule.scheduleName);
      expect(observed.properties?.dailyRecurrence?.time).toEqual("2200");
      expect(observed.properties?.status).toEqual("Enabled");
      expect(observed.tags?.["alchemy::id"]).toEqual("FabricOff");

      // In-place: time + status.
      const updated = yield* stack.deploy(
        program({ taskType: "LabVmsShutdownTask", time: "2300", status: "Disabled" }),
      );
      expect(updated.schedule.scheduleId).toEqual(schedule.scheduleId);
      const reobserved = yield* get(schedule.scheduleName);
      expect(reobserved.properties?.dailyRecurrence?.time).toEqual("2300");
      expect(reobserved.properties?.status).toEqual("Disabled");

      // Replacement: the task type (and with it the schedule name).
      const replaced = yield* stack.deploy(
        program({ taskType: "LabVmsStartupTask", time: "0700", status: "Enabled" }),
      );
      expect(replaced.schedule.scheduleName).toEqual("LabVmAutoStart");
      const startup = yield* get(replaced.schedule.scheduleName);
      expect(startup.properties?.taskType).toEqual("LabVmsStartupTask");
      expect(startup.properties?.weeklyRecurrence?.time).toEqual("0700");
      expect(startup.properties?.weeklyRecurrence?.weekdays).toEqual(["Monday", "Friday"]);
      expect(yield* waitGone(get(schedule.scheduleName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.schedule.scheduleName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
