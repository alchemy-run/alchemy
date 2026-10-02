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
  queueName: string,
  authorizationRuleName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetQueueAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      queueName,
      authorizationRuleName,
    });
  });

const ruleGone = (
  resourceGroupName: string,
  namespaceName: string,
  queueName: string,
  authorizationRuleName: string,
) =>
  getRule(
    resourceGroupName,
    namespaceName,
    queueName,
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
  const orders = yield* Azure.ServiceBus.Queue("Orders", {
    resourceGroup: group.resourceGroupName,
    namespace: bus.namespaceName,
  });
  return { group, bus, orders };
});

const program = (rights: Azure.ServiceBus.AccessRight[]) =>
  Effect.gen(function* () {
    const { group, bus, orders } = yield* base;
    const rule = yield* Azure.ServiceBus.QueueAuthorizationRule("Producer", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      queue: orders.queueName,
      rights,
    });
    return { group, bus, orders, rule };
  });

// Standard namespace + queue + SAS rule: ~$0.0135/h, a few minutes (<$0.01).
test.provider(
  "create, update, and delete a queue authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus, orders, rule } = yield* stack.deploy(
        program(["Send"]),
      );
      const rg = group.resourceGroupName;
      const ns = bus.namespaceName;
      expect(rule.rights).toEqual(["Send"]);
      expect(rule.queueName).toEqual(orders.queueName);
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        `EntityPath=${orders.queueName}`,
      );
      const observed = yield* getRule(
        rg,
        ns,
        orders.queueName,
        rule.authorizationRuleName,
      );
      expect(observed.properties?.rights).toEqual(["Send"]);

      // In place: add Listen.
      const updated = yield* stack.deploy(program(["Send", "Listen"]));
      expect(updated.rule.authorizationRuleName).toEqual(
        rule.authorizationRuleName,
      );
      const reobserved = yield* getRule(
        rg,
        ns,
        orders.queueName,
        rule.authorizationRuleName,
      );
      expect([...(reobserved.properties?.rights ?? [])].sort()).toEqual([
        "Listen",
        "Send",
      ]);

      // Removing only the rule deletes it while the queue stays.
      yield* stack.deploy(base);
      expect(
        yield* ruleGone(rg, ns, orders.queueName, rule.authorizationRuleName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
