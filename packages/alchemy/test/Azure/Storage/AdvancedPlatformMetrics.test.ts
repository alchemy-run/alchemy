import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetAdvancedPlatformMetrics({
      subscriptionId,
      resourceGroupName,
      accountName,
      advancedPlatformMetricsRuleType: "ContainerLevelCapacityMetrics",
    });
  });

const ruleGone = (resourceGroupName: string, accountName: string) =>
  getRule(resourceGroupName, accountName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("AdvancedPlatformMetricsRuleNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

type RuleSettings = Omit<
  Azure.Storage.AdvancedPlatformMetricsProps,
  "resourceGroup" | "storageAccount"
>;

const program = (rule?: RuleSettings) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const metrics = rule
      ? yield* Azure.Storage.AdvancedPlatformMetrics("ContainerMetrics", {
          ...rule,
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
        })
      : undefined;
    return { group, account, metrics };
  });

// Standard_LRS account with no data: ~$0, ~1 minute.
test.provider(
  "create, update, and delete an advanced platform metrics rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({}));
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      expect(created.metrics!.enabled).toEqual(true);
      expect(created.metrics!.filterType).toEqual("AllContainersFilter");
      const observed = yield* getRule(rg, acct);
      expect(observed.properties?.enabled).toEqual(true);

      // In-place update: only containers with a prefix.
      const updated = yield* stack.deploy(
        program({
          filterType: "ContainerPrefixFilter",
          filterValues: ["tenant-"],
        }),
      );
      expect(updated.metrics!.filterValues).toEqual(["tenant-"]);
      const reobserved = yield* getRule(rg, acct);
      expect(reobserved.properties?.ruleConfig.filterType).toEqual(
        "ContainerPrefixFilter",
      );
      expect(reobserved.properties?.ruleConfig.filterValues).toEqual([
        "tenant-",
      ]);

      // Removing the resource deletes the rule.
      yield* stack.deploy(program());
      expect(yield* ruleGone(rg, acct)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
