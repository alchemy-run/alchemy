import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name: string;
  rights: Azure.EventHub.AccessRight[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Basic",
    });
    const hub = yield* Azure.EventHub.EventHub("Orders", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      partitionCount: 1,
    });
    const rule = yield* Azure.EventHub.EventHubAuthorizationRule("Readers", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      eventHub: hub.eventHubName,
      name: props.name,
      rights: props.rights,
    });
    return { group, namespace, hub, rule };
  });

// Basic namespace (~$0.015/hour) for a few minutes: well under $0.05.
test.provider(
  "create, update, replace, and delete an event hub authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, hub, rule } = yield* stack.deploy(
        program({ name: "readers", rights: ["Listen"] }),
      );
      const subscriptionId = yield* subscription;
      const where = (authorizationRuleName: string) => ({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        namespaceName: namespace.namespaceName,
        eventHubName: hub.eventHubName,
        authorizationRuleName,
      });
      const get = (name: string) =>
        eventhub.GetEventHubAuthorizationRule(where(name));

      expect(rule.rights).toEqual(["Listen"]);
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        `EntityPath=${hub.eventHubName}`,
      );
      expect((yield* get("readers")).properties?.rights).toEqual(["Listen"]);

      // In-place: rights.
      const updated = yield* stack.deploy(
        program({ name: "readers", rights: ["Manage", "Send", "Listen"] }),
      );
      expect(updated.rule.authorizationRuleId).toEqual(rule.authorizationRuleId);
      expect([...((yield* get("readers")).properties?.rights ?? [])].sort()).toEqual(
        ["Listen", "Manage", "Send"],
      );
      const keys = yield* eventhub.ListEventHubKeys(where("readers"));
      expect(keys.primaryKey).toEqual(Redacted.value(updated.rule.primaryKey!));

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({ name: "admins", rights: ["Manage", "Send", "Listen"] }),
      );
      expect(replaced.rule.authorizationRuleName).toEqual("admins");
      expect((yield* get("admins")).name).toEqual("admins");
      expect(yield* waitGone(get("readers"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("admins"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
