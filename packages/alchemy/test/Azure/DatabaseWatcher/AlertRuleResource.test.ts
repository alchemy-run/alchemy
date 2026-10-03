import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as databasewatcher from "@distilled.cloud/azure/databasewatcher";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (
  resourceGroupName: string,
  watcherName: string,
  alertRuleResourceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* databasewatcher.GetAlertRuleResource({
      subscriptionId,
      resourceGroupName,
      watcherName,
      alertRuleResourceName,
    });
  });

const linkGone = (
  resourceGroupName: string,
  watcherName: string,
  alertRuleResourceName: string,
) =>
  getLink(resourceGroupName, watcherName, alertRuleResourceName).pipe(
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

// The link only records an alert rule ID; the watcher is never started, so
// the run is free (~8 minutes, dominated by the watcher create/delete).
const program = (link?: { version: string }) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const watcher = yield* Azure.DatabaseWatcher.Watcher("Watcher", {
      resourceGroup: group.resourceGroupName,
    });
    const l = link
      ? yield* Azure.DatabaseWatcher.AlertRuleResource("HighCpu", {
          resourceGroup: group.resourceGroupName,
          watcher: watcher.watcherName,
          alertRuleResourceId: Output.interpolate`/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Insights/scheduledQueryRules/alchemy-dw-high-cpu`,
          alertRuleTemplateId: "SqlDb-HighCpuUtilization",
          alertRuleTemplateVersion: link.version,
          creationTime: "2026-01-01T00:00:00Z",
        })
      : undefined;
    return { group, watcher, link: l };
  });

test.provider(
  "create, replace, and delete a database watcher alert rule link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ version: "1.0" }));
      const rg = created.group.resourceGroupName;
      const watcherName = created.watcher.watcherName;
      const first = created.link!;
      expect(first.alertRuleTemplateVersion).toEqual("1.0");
      const observed = yield* getLink(
        rg,
        watcherName,
        first.alertRuleResourceName,
      );
      expect(observed.properties?.alertRuleTemplateId).toEqual(
        "SqlDb-HighCpuUtilization",
      );
      expect(observed.properties?.alertRuleResourceId.toLowerCase()).toContain(
        "/scheduledqueryrules/alchemy-dw-high-cpu",
      );

      // Every property is immutable: a new template version replaces the link.
      const replaced = yield* stack.deploy(program({ version: "2.0" }));
      const second = replaced.link!;
      expect(second.alertRuleResourceName).not.toEqual(
        first.alertRuleResourceName,
      );
      const reobserved = yield* getLink(
        rg,
        watcherName,
        second.alertRuleResourceName,
      );
      expect(reobserved.properties?.alertRuleTemplateVersion).toEqual("2.0");
      expect(
        yield* linkGone(rg, watcherName, first.alertRuleResourceName),
      ).toEqual("gone");

      // Removing the link from the stack deletes it.
      yield* stack.deploy(program());
      expect(
        yield* linkGone(rg, watcherName, second.alertRuleResourceName),
      ).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:databasewatcher", "live"],
    timeout: 900_000,
  },
);
