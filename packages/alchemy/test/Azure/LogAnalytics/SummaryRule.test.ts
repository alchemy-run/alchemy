import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  workspaceName: string,
  summaryLogsName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetSummaryLog({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      summaryLogsName,
    });
  });

const ruleGone = (
  resourceGroupName: string,
  workspaceName: string,
  summaryLogsName: string,
) =>
  getRule(resourceGroupName, workspaceName, summaryLogsName).pipe(
    Effect.map((rule) =>
      rule.properties?.provisioningState === "Deleting"
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

const program = (rule?: {
  query: string;
  destinationTable: string;
  active?: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
    });
    const summary = rule
      ? yield* Azure.LogAnalytics.SummaryRule("Hourly", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          description: "hourly usage",
          query: rule.query,
          binSize: 60,
          destinationTable: rule.destinationTable,
          active: rule.active,
        })
      : undefined;
    return { group, workspace, summary };
  });

const QUERY = "Usage | summarize Quantity = sum(Quantity) by DataType";

test.provider(
  "create, update, stop, replace, and delete a summary rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ query: QUERY, destinationTable: "AlchemySummary_CL" }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      const first = created.summary!;
      expect(first.isActive).toEqual(true);
      expect(first.description).toEqual("hourly usage");
      const observed = yield* getRule(rg, ws, first.summaryRuleName);
      expect(observed.properties?.ruleDefinition?.query).toEqual(QUERY);
      expect(observed.properties?.ruleDefinition?.binSize).toEqual(60);
      expect(observed.properties?.description).toContain("[alchemy ");

      // In-place update of the query, then stop the rule.
      const updatedQuery = `${QUERY}, IsBillable`;
      const updated = yield* stack.deploy(
        program({
          query: updatedQuery,
          destinationTable: "AlchemySummary_CL",
          active: false,
        }),
      );
      expect(updated.summary!.summaryRuleName).toEqual(first.summaryRuleName);
      expect(updated.summary!.isActive).toEqual(false);
      const reobserved = yield* getRule(rg, ws, first.summaryRuleName);
      expect(reobserved.properties?.ruleDefinition?.query).toEqual(
        updatedQuery,
      );
      expect(reobserved.properties?.isActive).toEqual(false);

      // Changing the destination table replaces the rule.
      const replaced = yield* stack.deploy(
        program({ query: QUERY, destinationTable: "AlchemySummary2_CL" }),
      );
      expect(replaced.summary!.summaryRuleName).not.toEqual(
        first.summaryRuleName,
      );
      expect(replaced.summary!.destinationTable).toEqual("AlchemySummary2_CL");
      expect(yield* ruleGone(rg, ws, first.summaryRuleName)).toEqual("gone");

      yield* stack.deploy(program());
      expect(
        yield* ruleGone(rg, ws, replaced.summary!.summaryRuleName),
      ).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
