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
    const rule = yield* Azure.EventHub.NamespaceAuthorizationRule("Clients", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      name: props.name,
      rights: props.rights,
    });
    return { group, namespace, rule };
  });

// Basic namespace (~$0.015/hour) for a few minutes: well under $0.05.
test.provider(
  "create, update, replace, and delete a namespace authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, rule } = yield* stack.deploy(
        program({ name: "clients", rights: ["Listen"] }),
      );
      const subscriptionId = yield* subscription;
      const where = (authorizationRuleName: string) => ({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        namespaceName: namespace.namespaceName,
        authorizationRuleName,
      });
      const get = (name: string) =>
        eventhub.GetNamespaceAuthorizationRule(where(name));

      expect(rule.authorizationRuleName).toEqual("clients");
      expect(rule.rights).toEqual(["Listen"]);
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        "SharedAccessKeyName=clients",
      );
      expect((yield* get("clients")).properties?.rights).toEqual(["Listen"]);

      // In-place: rights.
      const updated = yield* stack.deploy(
        program({ name: "clients", rights: ["Send", "Listen"] }),
      );
      expect(updated.rule.authorizationRuleId).toEqual(rule.authorizationRuleId);
      expect([...((yield* get("clients")).properties?.rights ?? [])].sort()).toEqual(
        ["Listen", "Send"],
      );
      const keys = yield* eventhub.ListNamespaceKeys(where("clients"));
      expect(keys.primaryKey).toEqual(Redacted.value(updated.rule.primaryKey!));

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({ name: "producers", rights: ["Send", "Listen"] }),
      );
      expect(replaced.rule.authorizationRuleName).toEqual("producers");
      expect((yield* get("producers")).name).toEqual("producers");
      expect(yield* waitGone(get("clients"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("producers"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
