import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getExport = (
  resourceGroupName: string,
  workspaceName: string,
  dataExportName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetDataExport({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataExportName,
    });
  });

const exportGone = (
  resourceGroupName: string,
  workspaceName: string,
  dataExportName: string,
) =>
  getExport(resourceGroupName, workspaceName, dataExportName).pipe(
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

const columns: Azure.LogAnalytics.TableColumn[] = [
  { name: "TimeGenerated", type: "dateTime" },
  { name: "Message", type: "string" },
];

const program = (rule?: {
  name?: string;
  tables: ("first" | "second")[];
  enable?: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
    });
    const account = yield* Azure.Storage.StorageAccount("Archive", {
      resourceGroup: group.resourceGroupName,
    });
    const first = yield* Azure.LogAnalytics.Table("First", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      name: "AlchemyExportA_CL",
      columns,
    });
    const second = yield* Azure.LogAnalytics.Table("Second", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      name: "AlchemyExportB_CL",
      columns,
    });
    const tables = { first: first.tableName, second: second.tableName };
    const exported = rule
      ? yield* Azure.LogAnalytics.DataExport("Export", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          name: rule.name,
          tableNames: rule.tables.map((t) => tables[t]),
          destinationResourceId: account.storageAccountId,
          enable: rule.enable,
        })
      : undefined;
    return { group, workspace, account, exported };
  });

test.provider(
  "create, update, replace, and delete a data export rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tables: ["first"] }));
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      const first = created.exported!;
      expect(first.enable).toEqual(true);
      const observed = yield* getExport(rg, ws, first.dataExportName);
      expect(observed.properties?.tableNames).toEqual(["AlchemyExportA_CL"]);
      expect(observed.properties?.destination?.resourceId?.toLowerCase()).toEqual(
        created.account.storageAccountId.toLowerCase(),
      );

      // In-place update: add a table and disable the rule.
      const updated = yield* stack.deploy(
        program({ tables: ["first", "second"], enable: false }),
      );
      expect(updated.exported!.dataExportName).toEqual(first.dataExportName);
      const reobserved = yield* getExport(rg, ws, first.dataExportName);
      expect([...(reobserved.properties?.tableNames ?? [])].sort()).toEqual([
        "AlchemyExportA_CL",
        "AlchemyExportB_CL",
      ]);
      expect(reobserved.properties?.enable).toEqual(false);

      // Renaming replaces the rule.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-renamed-export", tables: ["second"] }),
      );
      expect(renamed.exported!.dataExportName).toEqual("alchemy-renamed-export");
      yield* getExport(rg, ws, "alchemy-renamed-export");
      expect(yield* exportGone(rg, ws, first.dataExportName)).toEqual("gone");

      yield* stack.deploy(program());
      expect(yield* exportGone(rg, ws, "alchemy-renamed-export")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
