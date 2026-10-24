import * as Azure from "@alchemy.run/azure";
import * as relay from "@distilled.cloud/azure/relay";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { gone, logLevel, namespaceProgram, subscriptionId, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (resourceGroupName: string, namespaceName: string, authorizationRuleName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    relay.GetNamespaceAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      authorizationRuleName,
    }),
  );

const RENAMED = "alchemy-relay-ns-rule-renamed";

const program = (props: { rights: Azure.Relay.RelayAccessRight[]; name?: string }) =>
  Effect.gen(function* () {
    const { group, ns } = yield* namespaceProgram;
    const rule = yield* Azure.Relay.NamespaceAuthorizationRule("Worker", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      name: props.name,
      rights: props.rights,
    });
    return { group, ns, rule };
  });

const sortedRights = (rule: relay.GetNamespaceAuthorizationRuleResponse) =>
  [...(rule.properties?.rights ?? [])].sort();

// Relay namespace (idle, ~$0) + one SAS rule (free); a few minutes.
test.provider(
  "create, update, replace, and delete a relay namespace authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, rule } = yield* stack.deploy(program({ rights: ["Send", "Listen"] }));
      const rg = group.resourceGroupName;
      expect(rule.rights).toEqual(["Listen", "Send"]);
      expect(rule.authorizationRuleId).toMatch(
        new RegExp(
          `/namespaces/${ns.namespaceName}/authorizationRules/${rule.authorizationRuleName}$`,
          "i",
        ),
      );
      expect(Redacted.isRedacted(rule.primaryConnectionString)).toEqual(true);
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        `SharedAccessKeyName=${rule.authorizationRuleName}`,
      );
      expect(Redacted.value(rule.primaryKey!).length).toBeGreaterThan(20);
      const observed = yield* getRule(rg, ns.namespaceName, rule.authorizationRuleName);
      expect(sortedRights(observed)).toEqual(["Listen", "Send"]);

      // In place: Manage (implies Listen + Send).
      const updated = yield* stack.deploy(program({ rights: ["Manage"] }));
      expect(updated.rule.authorizationRuleName).toEqual(rule.authorizationRuleName);
      expect(updated.rule.rights).toEqual(["Listen", "Manage", "Send"]);
      const reobserved = yield* getRule(rg, ns.namespaceName, rule.authorizationRuleName);
      expect(sortedRights(reobserved)).toEqual(["Listen", "Manage", "Send"]);

      // Replacement: an explicit name replaces the rule.
      const replaced = yield* stack.deploy(program({ rights: ["Listen"], name: RENAMED }));
      expect(replaced.rule.authorizationRuleName).toEqual(RENAMED);
      const renamed = yield* getRule(rg, ns.namespaceName, RENAMED);
      expect(sortedRights(renamed)).toEqual(["Listen"]);
      expect(yield* gone(getRule(rg, ns.namespaceName, rule.authorizationRuleName))).toEqual(
        "gone",
      );

      // Removing only the rule deletes it while the namespace stays.
      yield* stack.deploy(namespaceProgram);
      expect(yield* gone(getRule(rg, ns.namespaceName, RENAMED))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
