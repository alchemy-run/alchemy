import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

interface Where {
  resourceGroupName: string;
  namespaceName: string;
  topicName: string;
  subscriptionName: string;
  ruleName: string;
}

const getRule = (where: Where) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetRule({ subscriptionId, ...where });
  });

const ruleGone = (where: Where) =>
  getRule(where).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      [
        "ResourceNotFound",
        "ResourceGroupNotFound",
        "NotFound",
        "SubscriptionNotFound",
      ],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (
  rule: Pick<
    Azure.ServiceBus.RuleProps,
    "name" | "sqlFilter" | "correlationFilter" | "action"
  >,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const bus = yield* Azure.ServiceBus.Namespace("Bus", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const events = yield* Azure.ServiceBus.Topic("Events", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
    });
    const audit = yield* Azure.ServiceBus.Subscription("Audit", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      topic: events.topicName,
    });
    const filter = yield* Azure.ServiceBus.Rule("Filter", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      topic: events.topicName,
      subscription: audit.subscriptionName,
      ...rule,
    });
    return { group, bus, events, audit, filter };
  });

// Standard namespace + topic + subscription + rule: ~$0.0135/h, a few minutes (<$0.01).
test.provider(
  "create, update, replace, and delete a service bus rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create: SQL filter.
      const { group, bus, events, audit, filter } = yield* stack.deploy(
        program({ sqlFilter: { sqlExpression: "color = 'red'" } }),
      );
      const where = (ruleName: string): Where => ({
        resourceGroupName: group.resourceGroupName,
        namespaceName: bus.namespaceName,
        topicName: events.topicName,
        subscriptionName: audit.subscriptionName,
        ruleName,
      });
      expect(filter.ruleName.length).toBeLessThanOrEqual(50);
      expect(filter.ruleId).toContain(
        `/subscriptions/${audit.subscriptionName}/rules/${filter.ruleName}`,
      );
      const observed = yield* getRule(where(filter.ruleName));
      expect(observed.properties?.filterType).toEqual("SqlFilter");
      expect(observed.properties?.sqlFilter?.sqlExpression).toEqual(
        "color = 'red'",
      );

      // In place: switch to a correlation filter.
      const correlated = yield* stack.deploy(
        program({
          correlationFilter: { label: "order", properties: { region: "eu" } },
        }),
      );
      expect(correlated.filter.ruleName).toEqual(filter.ruleName);
      const reobserved = yield* getRule(where(filter.ruleName));
      expect(reobserved.properties?.filterType).toEqual("CorrelationFilter");
      expect(reobserved.properties?.correlationFilter?.label).toEqual("order");
      expect(
        reobserved.properties?.correlationFilter?.properties?.region,
      ).toEqual("eu");

      // In place: back to SQL with an action.
      yield* stack.deploy(
        program({
          sqlFilter: { sqlExpression: "amount > 1000" },
          action: { sqlExpression: "SET priority = 'high'" },
        }),
      );
      const withAction = yield* getRule(where(filter.ruleName));
      expect(withAction.properties?.filterType).toEqual("SqlFilter");
      expect(withAction.properties?.sqlFilter?.sqlExpression).toEqual(
        "amount > 1000",
      );
      expect(withAction.properties?.action?.sqlExpression).toEqual(
        "SET priority = 'high'",
      );

      // Replacement: explicit name.
      const renamed = yield* stack.deploy(
        program({
          name: "high-value",
          sqlFilter: { sqlExpression: "amount > 1000" },
        }),
      );
      expect(renamed.filter.ruleName).toEqual("high-value");
      const named = yield* getRule(where("high-value"));
      expect(named.properties?.sqlFilter?.sqlExpression).toEqual(
        "amount > 1000",
      );
      expect(yield* ruleGone(where(filter.ruleName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* ruleGone(where("high-value"))).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
