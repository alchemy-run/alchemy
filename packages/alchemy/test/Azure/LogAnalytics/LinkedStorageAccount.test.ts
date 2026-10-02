import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (
  resourceGroupName: string,
  workspaceName: string,
  dataSourceType: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetLinkedStorageAccount({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataSourceType,
    });
  });

const linkGone = (
  resourceGroupName: string,
  workspaceName: string,
  dataSourceType: string,
) =>
  getLink(resourceGroupName, workspaceName, dataSourceType).pipe(
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

const program = (link?: {
  dataSourceType: Azure.LogAnalytics.LinkedStorageDataSourceType;
  account: "a" | "b";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
    });
    const a = yield* Azure.Storage.StorageAccount("StoreA", {
      resourceGroup: group.resourceGroupName,
    });
    const b = yield* Azure.Storage.StorageAccount("StoreB", {
      resourceGroup: group.resourceGroupName,
    });
    const accounts = { a: a.storageAccountId, b: b.storageAccountId };
    const linked = link
      ? yield* Azure.LogAnalytics.LinkedStorageAccount("Link", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          dataSourceType: link.dataSourceType,
          storageAccountIds: [accounts[link.account]],
        })
      : undefined;
    return { group, workspace, accounts, linked };
  });

// The Storage provider does not manage network rules yet, and new accounts
// default to `bypass: None`, which Log Analytics rejects as faulted.
const allowAzureServices = (resourceGroupName: string, accountId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* storage.UpdateStorageAccount({
      subscriptionId,
      resourceGroupName,
      accountName: accountId.split("/").pop()!,
      properties: {
        networkAcls: { bypass: "AzureServices", defaultAction: "Allow" },
      },
    });
  });

const ids = (values: ReadonlyArray<string> | undefined) =>
  (values ?? []).map((v) => v.toLowerCase());

test.provider(
  "create, update, replace, and delete a linked storage account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program());
      for (const id of Object.values(base.accounts)) {
        yield* allowAzureServices(base.group.resourceGroupName, id);
      }

      const created = yield* stack.deploy(
        program({ dataSourceType: "Query", account: "a" }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      const observed = yield* getLink(rg, ws, "Query");
      expect(ids(observed.properties.storageAccountIds)).toEqual(
        ids([created.accounts.a]),
      );

      // In-place swap of the linked account.
      yield* stack.deploy(program({ dataSourceType: "Query", account: "b" }));
      const reobserved = yield* getLink(rg, ws, "Query");
      expect(ids(reobserved.properties.storageAccountIds)).toEqual(
        ids([created.accounts.b]),
      );

      // Changing the data source type replaces the link.
      const replaced = yield* stack.deploy(
        program({ dataSourceType: "Alerts", account: "b" }),
      );
      expect(replaced.linked!.dataSourceType).toEqual("Alerts");
      yield* getLink(rg, ws, "Alerts");
      expect(yield* linkGone(rg, ws, "Query")).toEqual("gone");

      yield* stack.deploy(program());
      expect(yield* linkGone(rg, ws, "Alerts")).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
