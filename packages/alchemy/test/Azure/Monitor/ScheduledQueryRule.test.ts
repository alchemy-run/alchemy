import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as monitor from "@distilled.cloud/azure/monitor";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (resourceGroupName: string, ruleName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* monitor.GetScheduledQueryRule({
      subscriptionId,
      resourceGroupName,
      ruleName,
    });
  });

const ruleGone = (resourceGroupName: string, ruleName: string) =>
  getRule(resourceGroupName, ruleName).pipe(
    Effect.as("found" as const),
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

const program = (props: {
  scope: "A" | "B";
  severity: 0 | 1 | 2 | 3 | 4;
  enabled: boolean;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both workspaces stay deployed across the scope replacement.
    const logsA = yield* Azure.LogAnalytics.Workspace("LogsA", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const logsB = yield* Azure.LogAnalytics.Workspace("LogsB", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const rule = yield* Azure.Monitor.ScheduledQueryRule("Rule", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      scopes: [props.scope === "A" ? logsA.workspaceId : logsB.workspaceId],
      description: props.description,
      severity: props.severity,
      enabled: props.enabled,
      evaluationFrequency: "PT15M",
      windowSize: "PT15M",
      skipQueryValidation: true,
      criteria: [
        {
          query: "Heartbeat",
          timeAggregation: "Count",
          operator: "GreaterThan",
          threshold: 0,
          failingPeriods: {
            numberOfEvaluationPeriods: 1,
            minFailingPeriodsToAlert: 1,
          },
        },
      ],
      tags: props.tags,
    });
    return { group, logsA, logsB, rule };
  });

// ~$0: a log alert bills ~$1.50/month at 15-minute frequency, and the
// pay-as-you-go workspaces bill only ingestion. Provisions in ~2 minutes.
test.provider(
  "create, update, replace, and delete a scheduled query rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          scope: "A",
          severity: 3,
          enabled: true,
          description: "first",
          tags: { env: "test" },
        }),
      );
      const rg = created.group.resourceGroupName;
      const first = created.rule;
      expect(first.ruleId).toMatch(/scheduledQueryRules/i);
      expect(first.kind).toEqual("LogAlert");
      const observed = yield* getRule(rg, first.ruleName);
      expect(observed.properties.severity).toEqual(3);
      expect(observed.properties.enabled).toEqual(true);
      expect(observed.properties.description).toEqual("first");
      expect(observed.properties.scopes?.[0]?.toLowerCase()).toEqual(
        created.logsA.workspaceId.toLowerCase(),
      );
      expect(observed.properties.criteria?.allOf?.[0]?.query).toEqual(
        "Heartbeat",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Rule");

      // In-place update: severity, enabled, description, tags.
      const updated = yield* stack.deploy(
        program({
          scope: "A",
          severity: 1,
          enabled: false,
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(updated.rule.ruleId).toEqual(first.ruleId);
      const reobserved = yield* getRule(rg, first.ruleName);
      expect(reobserved.properties.severity).toEqual(1);
      expect(reobserved.properties.enabled).toEqual(false);
      expect(reobserved.properties.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Changing the scope replaces the rule.
      const moved = yield* stack.deploy(
        program({
          scope: "B",
          severity: 1,
          enabled: false,
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(moved.rule.ruleName).not.toEqual(first.ruleName);
      const replaced = yield* getRule(rg, moved.rule.ruleName);
      expect(replaced.properties.scopes?.[0]?.toLowerCase()).toEqual(
        moved.logsB.workspaceId.toLowerCase(),
      );
      expect(yield* ruleGone(rg, first.ruleName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* ruleGone(rg, moved.rule.ruleName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:monitor", "live"],
    timeout: 900_000,
  },
);
