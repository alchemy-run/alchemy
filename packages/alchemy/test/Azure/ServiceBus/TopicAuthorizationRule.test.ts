import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getRule = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
  authorizationRuleName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetTopicAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
      authorizationRuleName,
    });
  });

const ruleGone = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
  authorizationRuleName: string,
) =>
  getRule(
    resourceGroupName,
    namespaceName,
    topicName,
    authorizationRuleName,
  ).pipe(
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

const base = Effect.gen(function* () {
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
  return { group, bus, events };
});

const program = (rights: Azure.ServiceBus.AccessRight[]) =>
  Effect.gen(function* () {
    const { group, bus, events } = yield* base;
    const rule = yield* Azure.ServiceBus.TopicAuthorizationRule("Publisher", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      topic: events.topicName,
      rights,
    });
    return { group, bus, events, rule };
  });

// Standard namespace + topic + SAS rule: ~$0.0135/h, a few minutes (<$0.01).
test.provider(
  "create, update, and delete a topic authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus, events, rule } = yield* stack.deploy(
        program(["Send"]),
      );
      const rg = group.resourceGroupName;
      const ns = bus.namespaceName;
      expect(rule.rights).toEqual(["Send"]);
      expect(rule.topicName).toEqual(events.topicName);
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        `EntityPath=${events.topicName}`,
      );
      const observed = yield* getRule(
        rg,
        ns,
        events.topicName,
        rule.authorizationRuleName,
      );
      expect(observed.properties?.rights).toEqual(["Send"]);

      // In place: Manage (implies Listen + Send).
      const updated = yield* stack.deploy(program(["Manage"]));
      expect(updated.rule.authorizationRuleName).toEqual(
        rule.authorizationRuleName,
      );
      const reobserved = yield* getRule(
        rg,
        ns,
        events.topicName,
        rule.authorizationRuleName,
      );
      expect([...(reobserved.properties?.rights ?? [])].sort()).toEqual([
        "Listen",
        "Manage",
        "Send",
      ]);

      // Removing only the rule deletes it while the topic stays.
      yield* stack.deploy(base);
      expect(
        yield* ruleGone(rg, ns, events.topicName, rule.authorizationRuleName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
