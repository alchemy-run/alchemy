import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as alertsmanagement from "@distilled.cloud/azure/alertsmanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (resourceGroupName: string, ruleGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* alertsmanagement.GetPrometheusRuleGroup({
      subscriptionId,
      resourceGroupName,
      ruleGroupName,
    });
  });

const groupGone = (resourceGroupName: string, ruleGroupName: string) =>
  getGroup(resourceGroupName, ruleGroupName).pipe(
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

const RECORD: Azure.Monitor.PrometheusRule = {
  record: "job:up:sum",
  expression: "sum by (job) (up)",
};

const ALERT: Azure.Monitor.PrometheusRule = {
  alert: "TargetDown",
  expression: "up == 0",
  for: "PT5M",
  severity: 3,
  annotations: { summary: "A scrape target is down" },
  resolveConfiguration: { autoResolved: true, timeToResolve: "PT10M" },
};

const program = (props: {
  name?: string;
  interval: string;
  withAlert: boolean;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const metrics = yield* Azure.Monitor.Workspace("Metrics", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const rules = yield* Azure.Monitor.PrometheusRuleGroup("Rules", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      location: "eastus",
      scopes: [metrics.workspaceId],
      interval: props.interval,
      description: props.description,
      rules: props.withAlert ? [RECORD, ALERT] : [RECORD],
      tags: props.tags,
    });
    return { group, metrics, rules };
  });

// Free: the Azure Monitor workspace bills only ingested samples (none here)
// and rule evaluation over an empty workspace is negligible. ~2 minutes.
test.provider(
  "create, update, replace, and delete a Prometheus rule group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          interval: "PT1M",
          withAlert: false,
          description: "first",
          tags: { env: "test" },
        }),
      );
      const rg = created.group.resourceGroupName;
      const first = created.rules;
      expect(first.ruleGroupId).toMatch(/prometheusRuleGroups/i);
      expect(first.interval).toEqual("PT1M");
      const observed = yield* getGroup(rg, first.ruleGroupName);
      expect(observed.properties.scopes[0]?.toLowerCase()).toEqual(
        created.metrics.workspaceId.toLowerCase(),
      );
      expect(observed.properties.rules.map((r) => r.record)).toEqual([
        "job:up:sum",
      ]);
      expect(observed.properties.description).toEqual("first");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Rules");

      // In-place update: add an alerting rule, change interval and tags.
      const updated = yield* stack.deploy(
        program({
          interval: "PT5M",
          withAlert: true,
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(updated.rules.ruleGroupId).toEqual(first.ruleGroupId);
      const reobserved = yield* getGroup(rg, first.ruleGroupName);
      expect(reobserved.properties.interval).toEqual("PT5M");
      expect(reobserved.properties.description).toEqual("second");
      expect(reobserved.properties.rules).toHaveLength(2);
      expect(reobserved.properties.rules[1]?.alert).toEqual("TargetDown");
      expect(reobserved.properties.rules[1]?.severity).toEqual(3);
      expect(reobserved.tags?.env).toEqual("prod");

      // Renaming replaces the rule group.
      const renamed = yield* stack.deploy(
        program({
          name: "alchemy-prom-renamed",
          interval: "PT5M",
          withAlert: true,
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(renamed.rules.ruleGroupName).toEqual("alchemy-prom-renamed");
      const replaced = yield* getGroup(rg, renamed.rules.ruleGroupName);
      expect(replaced.properties.rules).toHaveLength(2);
      expect(yield* groupGone(rg, first.ruleGroupName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* groupGone(rg, renamed.rules.ruleGroupName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:monitor", "live"],
    timeout: 900_000,
  },
);
