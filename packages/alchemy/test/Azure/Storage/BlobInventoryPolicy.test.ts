import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetBlobInventoryPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      blobInventoryPolicyName: "default",
    });
  });

const policyGone = (resourceGroupName: string, accountName: string) =>
  getPolicy(resourceGroupName, accountName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("BlobInventoryPolicyNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

interface Settings {
  enabled?: boolean;
  rule: Omit<Azure.Storage.InventoryRule, "destination">;
}

const program = (settings?: Settings) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const reports = yield* Azure.Storage.BlobContainer("Reports", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
    });
    const inventory = settings
      ? yield* Azure.Storage.BlobInventoryPolicy("Inventory", {
          enabled: settings.enabled,
          rules: [{ ...settings.rule, destination: reports.containerName }],
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
        })
      : undefined;
    return { group, account, reports, inventory };
  });

// Standard_LRS account; the policy is deleted before the first daily run:
// ~$0, ~1 minute.
test.provider(
  "create, update, and delete a blob inventory policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          rule: {
            name: "allBlobs",
            schemaFields: ["Name", "Creation-Time", "Content-Length"],
            filters: { blobTypes: ["blockBlob"] },
          },
        }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      expect(created.inventory!.ruleNames).toEqual(["allBlobs"]);
      expect(created.inventory!.enabled).toEqual(true);
      const observed = yield* getPolicy(rg, acct);
      const rule = observed.properties?.policy.rules[0];
      expect(rule?.destination).toEqual(created.reports.containerName);
      expect(rule?.definition.format).toEqual("Csv");
      expect(rule?.definition.schedule).toEqual("Daily");

      // In-place update: disable the policy and switch the rule to a weekly
      // Parquet report of containers.
      yield* stack.deploy(
        program({
          enabled: false,
          rule: {
            name: "allBlobs",
            objectType: "Container",
            format: "Parquet",
            schedule: "Weekly",
            schemaFields: ["Name", "Last-Modified"],
          },
        }),
      );
      const reobserved = yield* getPolicy(rg, acct);
      expect(reobserved.properties?.policy.enabled).toEqual(false);
      const updatedRule = reobserved.properties?.policy.rules[0];
      expect(updatedRule?.definition.objectType).toEqual("Container");
      expect(updatedRule?.definition.format).toEqual("Parquet");
      expect(updatedRule?.definition.schedule).toEqual("Weekly");

      // Removing the resource deletes the policy.
      yield* stack.deploy(program());
      expect(yield* policyGone(rg, acct)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
