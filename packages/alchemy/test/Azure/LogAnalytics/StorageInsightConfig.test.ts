import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getConfig = (
  resourceGroupName: string,
  workspaceName: string,
  storageInsightName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetStorageInsightConfig({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      storageInsightName,
    });
  });

const configGone = (
  resourceGroupName: string,
  workspaceName: string,
  storageInsightName: string,
) =>
  getConfig(resourceGroupName, workspaceName, storageInsightName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const accountKeys = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const result = yield* storage.ListStorageAccountKeys({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
    return (result.keys ?? []).map((key) => Redacted.make(key.value!));
  });

const program = (config?: {
  name?: string;
  key: Redacted.Redacted<string>;
  tables: string[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
    });
    const account = yield* Azure.Storage.StorageAccount("Diagnostics", {
      resourceGroup: group.resourceGroupName,
    });
    const insight = config
      ? yield* Azure.LogAnalytics.StorageInsightConfig("Insight", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          name: config.name,
          storageAccountId: account.storageAccountId,
          storageAccountKey: config.key,
          tables: config.tables,
          containers: ["wad-iis-logfiles"],
          tags: { env: "test" },
        })
      : undefined;
    return { group, workspace, account, insight };
  });

test.provider(
  "create, update, replace, and delete a storage insight config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program());
      const rg = base.group.resourceGroupName;
      const ws = base.workspace.workspaceName;
      const [key1, key2] = yield* accountKeys(
        rg,
        base.account.storageAccountName,
      );

      const created = yield* stack.deploy(
        program({ key: key1!, tables: ["WADWindowsEventLogsTable"] }),
      );
      const first = created.insight!;
      const observed = yield* getConfig(rg, ws, first.storageInsightConfigName);
      expect(observed.properties?.tables).toEqual(["WADWindowsEventLogsTable"]);
      expect(observed.properties?.containers).toEqual(["wad-iis-logfiles"]);
      expect(observed.tags?.["alchemy::id"]).toEqual("Insight");

      // In-place update: rotate to the second key and add a table.
      const updated = yield* stack.deploy(
        program({
          key: key2!,
          tables: ["WADWindowsEventLogsTable", "LinuxsyslogVer2v0"],
        }),
      );
      expect(updated.insight!.storageInsightConfigName).toEqual(
        first.storageInsightConfigName,
      );
      expect(updated.insight!.storageAccountKeyHash).not.toEqual(
        first.storageAccountKeyHash,
      );
      const reobserved = yield* getConfig(
        rg,
        ws,
        first.storageInsightConfigName,
      );
      expect([...(reobserved.properties?.tables ?? [])].sort()).toEqual([
        "LinuxsyslogVer2v0",
        "WADWindowsEventLogsTable",
      ]);

      // Renaming replaces the config.
      const renamed = yield* stack.deploy(
        program({
          name: "alchemy-renamed-insight",
          key: key2!,
          tables: ["WADWindowsEventLogsTable"],
        }),
      );
      expect(renamed.insight!.storageInsightConfigName).toEqual(
        "alchemy-renamed-insight",
      );
      yield* getConfig(rg, ws, "alchemy-renamed-insight");
      expect(
        yield* configGone(rg, ws, first.storageInsightConfigName),
      ).toEqual("gone");

      yield* stack.deploy(program());
      expect(yield* configGone(rg, ws, "alchemy-renamed-insight")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
