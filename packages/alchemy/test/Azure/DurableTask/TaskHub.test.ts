import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as durabletask from "@distilled.cloud/azure/durabletask";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const LOCATION = "westus2";

const getTaskHub = (
  resourceGroupName: string,
  schedulerName: string,
  taskHubName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* durabletask.GetTaskHub({
      subscriptionId,
      resourceGroupName,
      schedulerName,
      taskHubName,
    });
  });

const taskHubGone = (
  resourceGroupName: string,
  schedulerName: string,
  taskHubName: string,
) =>
  getTaskHub(resourceGroupName, schedulerName, taskHubName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (hub?: { name?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const scheduler = yield* Azure.DurableTask.Scheduler("Scheduler", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const taskHub = hub
      ? yield* Azure.DurableTask.TaskHub("Hub", {
          resourceGroup: group.resourceGroupName,
          scheduler: scheduler.schedulerName,
          name: hub.name,
        })
      : undefined;
    return { group, scheduler, taskHub };
  });

// Consumption scheduler + task hub: billed per action, ~$0 idle.
// Scheduler provisioning takes ~3-8 minutes.
test.provider(
  "create, replace, and delete a durable task hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({}));
      const rg = created.group.resourceGroupName;
      const scheduler = created.scheduler.schedulerName;
      const first = created.taskHub!;
      expect(first.scheduler).toEqual(scheduler);
      const observed = yield* getTaskHub(rg, scheduler, first.taskHubName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(first.taskHubId).toEqual(observed.id);
      expect(first.dashboardUrl).toEqual(observed.properties?.dashboardUrl);

      // A redeploy with no changes keeps the hub.
      const same = yield* stack.deploy(program({}));
      expect(same.taskHub!.taskHubName).toEqual(first.taskHubName);

      // Renaming replaces the hub.
      const renamed = yield* stack.deploy(program({ name: "alchemy-hub-2" }));
      expect(renamed.taskHub!.taskHubName).toEqual("alchemy-hub-2");
      yield* getTaskHub(rg, scheduler, "alchemy-hub-2");
      expect(yield* taskHubGone(rg, scheduler, first.taskHubName)).toEqual(
        "gone",
      );

      // Removing the hub from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* taskHubGone(rg, scheduler, "alchemy-hub-2")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:durabletask", "live"],
    timeout: 900_000,
  },
);
