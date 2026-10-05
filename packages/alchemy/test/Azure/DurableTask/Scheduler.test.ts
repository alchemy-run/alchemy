import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as durabletask from "@distilled.cloud/azure/durabletask";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const LOCATION = "westus2";

const getScheduler = (resourceGroupName: string, schedulerName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* durabletask.GetScheduler({
      subscriptionId,
      resourceGroupName,
      schedulerName,
    });
  });

const schedulerGone = (resourceGroupName: string, schedulerName: string) =>
  getScheduler(resourceGroupName, schedulerName).pipe(
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

const program = (scheduler?: {
  name?: string;
  ipAllowlist?: string[];
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const created = scheduler
      ? yield* Azure.DurableTask.Scheduler("Scheduler", {
          resourceGroup: group.resourceGroupName,
          location: LOCATION,
          name: scheduler.name,
          ipAllowlist: scheduler.ipAllowlist,
          tags: scheduler.tags,
        })
      : undefined;
    return { group, scheduler: created };
  });

// Consumption SKU: billed per action, so an idle create/update/delete costs
// ~$0. Provisioning takes ~3-8 minutes per scheduler.
test.provider(
  "create, update, replace, and delete a durable task scheduler",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const first = created.scheduler!;
      expect(first.sku).toEqual("Consumption");
      expect(first.endpoint).toMatch(/^https:\/\//);
      expect(first.ipAllowlist).toEqual(["0.0.0.0/0"]);
      expect(first.tags).toEqual({ env: "test" });
      const observed = yield* getScheduler(rg, first.schedulerName);
      expect(observed.tags?.["alchemy::id"]).toEqual("Scheduler");
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // In-place update of the allow list and tags.
      const updated = yield* stack.deploy(
        program({
          ipAllowlist: ["203.0.113.0/24"],
          tags: { env: "test", owner: "ops" },
        }),
      );
      expect(updated.scheduler!.schedulerName).toEqual(first.schedulerName);
      expect(updated.scheduler!.endpoint).toEqual(first.endpoint);
      const reobserved = yield* getScheduler(rg, first.schedulerName);
      expect(reobserved.properties?.ipAllowlist).toEqual(["203.0.113.0/24"]);
      expect(reobserved.tags?.owner).toEqual("ops");

      // Renaming replaces the scheduler.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-dts-renamed", ipAllowlist: ["0.0.0.0/0"] }),
      );
      expect(renamed.scheduler!.schedulerName).toEqual("alchemy-dts-renamed");
      const replacement = yield* getScheduler(rg, "alchemy-dts-renamed");
      expect(replacement.tags?.["alchemy::id"]).toEqual("Scheduler");
      expect(yield* schedulerGone(rg, first.schedulerName)).toEqual("gone");

      // Removing the scheduler from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* schedulerGone(rg, "alchemy-dts-renamed")).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:durabletask", "live"],
    timeout: 900_000,
  },
);
