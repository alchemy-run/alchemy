import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storageactions from "@distilled.cloud/azure/storageactions";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getTask = (resourceGroupName: string, storageTaskName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storageactions.GetStorageTask({
      subscriptionId,
      resourceGroupName,
      storageTaskName,
    });
  });

const taskGone = (resourceGroupName: string, storageTaskName: string) =>
  getTask(resourceGroupName, storageTaskName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const tierAction = (tier: string): Azure.StorageActions.StorageTaskAction => ({
  if: {
    condition: "[[equals(AccessTier, 'Hot')]]",
    operations: [{ name: "SetBlobTier", parameters: { tier } }],
  },
});

const program = (props: {
  name?: string;
  enabled: boolean;
  description: string;
  tier: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const task = yield* Azure.StorageActions.StorageTask("Tiering", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      enabled: props.enabled,
      description: props.description,
      action: tierAction(props.tier),
      tags: props.tags,
    });
    return { group, task };
  });

// An unassigned storage task costs $0 and provisions in under a minute.
test.provider(
  "create, update, replace, and delete a storage task",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        program({
          enabled: true,
          description: "move hot blobs to cool",
          tier: "Cool",
          tags: { env: "test" },
        }),
      );
      const { group, task } = created;
      expect(task.storageTaskName).toMatch(/^[a-z0-9]{3,18}$/);
      expect(task.storageTaskId).toContain(
        `/providers/Microsoft.StorageActions/storageTasks/${task.storageTaskName}`,
      );
      expect(task.enabled).toEqual(true);
      expect(task.identityType).toEqual("SystemAssigned");
      expect(task.principalId).toBeTruthy();
      expect(task.tags).toEqual({ env: "test" });

      const observed = yield* getTask(
        group.resourceGroupName,
        task.storageTaskName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.description).toEqual("move hot blobs to cool");
      expect(observed.properties.action.if.operations[0]?.parameters).toEqual({
        tier: "Cool",
      });
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Tiering");

      // In-place update: enabled, description, action, and tags.
      const updated = yield* stack.deploy(
        program({
          enabled: false,
          description: "move hot blobs to archive",
          tier: "Archive",
          tags: { env: "prod" },
        }),
      );
      expect(updated.task.storageTaskName).toEqual(task.storageTaskName);
      expect(updated.task.storageTaskId).toEqual(task.storageTaskId);
      const reobserved = yield* getTask(
        group.resourceGroupName,
        task.storageTaskName,
      );
      expect(reobserved.properties.enabled).toEqual(false);
      expect(reobserved.properties.description).toEqual(
        "move hot blobs to archive",
      );
      expect(reobserved.properties.action.if.operations[0]?.parameters).toEqual(
        { tier: "Archive" },
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: an explicit name replaces the task.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemytaskrepl",
          enabled: false,
          description: "move hot blobs to archive",
          tier: "Archive",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.task.storageTaskName).toEqual("alchemytaskrepl");
      expect(
        yield* taskGone(group.resourceGroupName, task.storageTaskName),
      ).toEqual("gone");
      const replacement = yield* getTask(
        group.resourceGroupName,
        "alchemytaskrepl",
      );
      expect(replacement.properties.provisioningState).toEqual("Succeeded");

      // Delete.
      yield* stack.destroy();
      expect(
        yield* taskGone(group.resourceGroupName, "alchemytaskrepl"),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:storageactions", "live"],
    timeout: 600_000,
  },
);
