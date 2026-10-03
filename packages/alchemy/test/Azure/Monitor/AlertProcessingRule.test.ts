import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as alertsmanagement from "@distilled.cloud/azure/alertsmanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (resourceGroupName: string, alertProcessingRuleName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* alertsmanagement.GetAlertProcessingRuleByName({
      subscriptionId,
      resourceGroupName,
      alertProcessingRuleName,
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
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (props: {
  name?: string;
  enabled: boolean;
  description: string;
  weekends: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const rule = yield* Azure.Monitor.AlertProcessingRule("Rule", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      scopes: [group.resourceGroupId],
      actions: [{ actionType: "RemoveAllActionGroups" }],
      conditions: [
        { field: "Severity", operator: "Equals", values: ["Sev3", "Sev4"] },
      ],
      schedule: props.weekends
        ? {
            timeZone: "UTC",
            recurrences: [
              {
                recurrenceType: "Weekly",
                daysOfWeek: ["Saturday", "Sunday"],
              },
            ],
          }
        : undefined,
      description: props.description,
      enabled: props.enabled,
      tags: props.tags,
    });
    return { group, rule };
  });

// Free: alert processing rules carry no charge. Provisions in seconds.
test.provider(
  "create, update, replace, and delete an alert processing rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          enabled: true,
          description: "first",
          weekends: false,
          tags: { env: "test" },
        }),
      );
      const rg = created.group.resourceGroupName;
      const first = created.rule;
      expect(first.ruleId).toMatch(/actionRules/i);
      expect(first.enabled).toEqual(true);
      const observed = yield* getRule(rg, first.ruleName);
      expect(observed.properties?.description).toEqual("first");
      expect(observed.properties?.actions[0]?.actionType).toEqual(
        "RemoveAllActionGroups",
      );
      expect(observed.properties?.conditions?.[0]?.values).toEqual([
        "Sev3",
        "Sev4",
      ]);
      expect(observed.properties?.schedule).toBeUndefined();
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Rule");

      // In-place update: schedule, enabled, description, tags.
      const updated = yield* stack.deploy(
        program({
          enabled: false,
          description: "second",
          weekends: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.rule.ruleId).toEqual(first.ruleId);
      expect(updated.rule.enabled).toEqual(false);
      const reobserved = yield* getRule(rg, first.ruleName);
      expect(reobserved.properties?.enabled).toEqual(false);
      expect(reobserved.properties?.description).toEqual("second");
      expect(
        reobserved.properties?.schedule?.recurrences?.[0]?.daysOfWeek,
      ).toEqual(["Saturday", "Sunday"]);
      expect(reobserved.tags?.env).toEqual("prod");

      // Renaming replaces the rule.
      const renamed = yield* stack.deploy(
        program({
          name: "alchemy-apr-renamed",
          enabled: false,
          description: "second",
          weekends: true,
          tags: { env: "prod" },
        }),
      );
      expect(renamed.rule.ruleName).toEqual("alchemy-apr-renamed");
      const replaced = yield* getRule(rg, renamed.rule.ruleName);
      expect(replaced.properties?.description).toEqual("second");
      expect(yield* ruleGone(rg, first.ruleName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* ruleGone(rg, renamed.rule.ruleName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:monitor", "live"],
    timeout: 900_000,
  },
);
