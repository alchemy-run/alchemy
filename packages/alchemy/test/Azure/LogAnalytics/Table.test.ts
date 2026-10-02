import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getTable = (
  resourceGroupName: string,
  workspaceName: string,
  tableName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetTable({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      tableName,
    });
  });

const tableGone = (
  resourceGroupName: string,
  workspaceName: string,
  tableName: string,
) =>
  getTable(resourceGroupName, workspaceName, tableName).pipe(
    Effect.map((table) =>
      table.properties?.provisioningState === "Deleting"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const baseColumns: Azure.LogAnalytics.TableColumn[] = [
  { name: "TimeGenerated", type: "dateTime" },
  { name: "Message", type: "string" },
];

const program = (table?: {
  name?: string;
  columns: Azure.LogAnalytics.TableColumn[];
  retentionInDays?: number;
  description?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
    });
    const custom = table
      ? yield* Azure.LogAnalytics.Table("Events", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          name: table.name,
          columns: table.columns,
          retentionInDays: table.retentionInDays,
          description: table.description,
        })
      : undefined;
    return { group, workspace, custom };
  });

test.provider(
  "create, update, replace, and delete a Log Analytics custom table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ columns: baseColumns, description: "app events" }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      const first = created.custom!;
      expect(first.tableName).toMatch(/^[A-Za-z][A-Za-z0-9_]*_CL$/);
      expect(first.description).toEqual("app events");
      const observed = yield* getTable(rg, ws, first.tableName);
      expect(observed.properties?.plan).toEqual("Analytics");
      expect(observed.properties?.schema?.description).toContain(
        "[alchemy ",
      );
      expect(
        observed.properties?.schema?.columns?.map((c) => c.name),
      ).toContain("Message");

      // In-place update: add a column and set retention.
      const updated = yield* stack.deploy(
        program({
          columns: [...baseColumns, { name: "Level", type: "string" }],
          retentionInDays: 60,
          description: "app events",
        }),
      );
      expect(updated.custom!.tableName).toEqual(first.tableName);
      expect(updated.custom!.retentionInDays).toEqual(60);
      const reobserved = yield* getTable(rg, ws, first.tableName);
      expect(reobserved.properties?.retentionInDays).toEqual(60);
      expect(
        reobserved.properties?.schema?.columns?.map((c) => c.name),
      ).toContain("Level");

      // Renaming replaces the table.
      const renamed = yield* stack.deploy(
        program({
          name: "AlchemyRenamed_CL",
          columns: baseColumns,
          description: "app events",
        }),
      );
      expect(renamed.custom!.tableName).toEqual("AlchemyRenamed_CL");
      const replacement = yield* getTable(rg, ws, "AlchemyRenamed_CL");
      expect(
        replacement.properties?.schema?.columns?.map((c) => c.name),
      ).not.toContain("Level");
      expect(yield* tableGone(rg, ws, first.tableName)).toEqual("gone");

      // Removing the table from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* tableGone(rg, ws, "AlchemyRenamed_CL")).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
