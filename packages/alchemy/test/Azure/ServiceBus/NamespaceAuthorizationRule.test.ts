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
  authorizationRuleName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetNamespaceAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      authorizationRuleName,
    });
  });

const ruleGone = (
  resourceGroupName: string,
  namespaceName: string,
  authorizationRuleName: string,
) =>
  getRule(resourceGroupName, namespaceName, authorizationRuleName).pipe(
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

const program = (rights: Azure.ServiceBus.AccessRight[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const bus = yield* Azure.ServiceBus.Namespace("Bus", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const rule = yield* Azure.ServiceBus.NamespaceAuthorizationRule("Worker", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      rights,
    });
    return { group, bus, rule };
  });

// Standard namespace + one SAS rule: ~$0.0135/h, a few minutes (<$0.01).
test.provider(
  "create, update, and delete a namespace authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus, rule } = yield* stack.deploy(
        program(["Send", "Listen"]),
      );
      const rg = group.resourceGroupName;
      expect(rule.rights).toEqual(["Listen", "Send"]);
      expect(rule.primaryConnectionString).toBeDefined();
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        `SharedAccessKeyName=${rule.authorizationRuleName}`,
      );
      expect(Redacted.value(rule.primaryKey!).length).toBeGreaterThan(20);
      const observed = yield* getRule(
        rg,
        bus.namespaceName,
        rule.authorizationRuleName,
      );
      expect([...(observed.properties?.rights ?? [])].sort()).toEqual([
        "Listen",
        "Send",
      ]);

      // In place: add Manage (implies Listen + Send).
      const updated = yield* stack.deploy(program(["Manage"]));
      expect(updated.rule.authorizationRuleName).toEqual(
        rule.authorizationRuleName,
      );
      expect(updated.rule.rights).toEqual(["Listen", "Manage", "Send"]);
      const reobserved = yield* getRule(
        rg,
        bus.namespaceName,
        rule.authorizationRuleName,
      );
      expect([...(reobserved.properties?.rights ?? [])].sort()).toEqual([
        "Listen",
        "Manage",
        "Send",
      ]);

      // Removing only the rule deletes it while the namespace stays.
      yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const bus = yield* Azure.ServiceBus.Namespace("Bus", {
            resourceGroup: group.resourceGroupName,
            sku: "Standard",
          });
          return { group, bus };
        }),
      );
      expect(
        yield* ruleGone(rg, bus.namespaceName, rule.authorizationRuleName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
