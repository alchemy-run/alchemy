import * as Azure from "@alchemy.run/azure";
import * as relay from "@distilled.cloud/azure/relay";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { gone, logLevel, namespaceProgram, subscriptionId, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  namespaceName: string,
  relayName: string,
  authorizationRuleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    relay.GetWCFRelayAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      relayName,
      authorizationRuleName,
    }),
  );

const RENAMED = "alchemy-relay-wcf-rule-renamed";

const relayProgram = Effect.gen(function* () {
  const { group, ns } = yield* namespaceProgram;
  const wcf = yield* Azure.Relay.WcfRelay("Wcf", {
    resourceGroup: group.resourceGroupName,
    namespace: ns.namespaceName,
    relayType: "NetTcp",
  });
  return { group, ns, wcf };
});

const program = (props: { rights: Azure.Relay.RelayAccessRight[]; name?: string }) =>
  Effect.gen(function* () {
    const { group, ns, wcf } = yield* relayProgram;
    const rule = yield* Azure.Relay.WcfRelayAuthorizationRule("Sender", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      wcfRelay: wcf.relayName,
      name: props.name,
      rights: props.rights,
    });
    return { group, ns, wcf, rule };
  });

const sortedRights = (rule: relay.GetWCFRelayAuthorizationRuleResponse) =>
  [...(rule.properties?.rights ?? [])].sort();

// Relay namespace + WCF relay with no listeners (~$0) + one SAS rule
// (free); a few minutes.
test.provider(
  "create, update, replace, and delete a relay wcf relay authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, wcf, rule } = yield* stack.deploy(program({ rights: ["Send"] }));
      const rg = group.resourceGroupName;
      expect(rule.relayName).toEqual(wcf.relayName);
      expect(rule.rights).toEqual(["Send"]);
      expect(Redacted.isRedacted(rule.primaryConnectionString)).toEqual(true);
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        `SharedAccessKeyName=${rule.authorizationRuleName}`,
      );
      const observed = yield* getRule(
        rg,
        ns.namespaceName,
        wcf.relayName,
        rule.authorizationRuleName,
      );
      expect(sortedRights(observed)).toEqual(["Send"]);

      // In place: Manage (implies Listen + Send).
      const updated = yield* stack.deploy(program({ rights: ["Manage"] }));
      expect(updated.rule.authorizationRuleName).toEqual(rule.authorizationRuleName);
      expect(updated.rule.rights).toEqual(["Listen", "Manage", "Send"]);
      const reobserved = yield* getRule(
        rg,
        ns.namespaceName,
        wcf.relayName,
        rule.authorizationRuleName,
      );
      expect(sortedRights(reobserved)).toEqual(["Listen", "Manage", "Send"]);

      // Replacement: an explicit name replaces the rule.
      const replaced = yield* stack.deploy(program({ rights: ["Listen"], name: RENAMED }));
      expect(replaced.rule.authorizationRuleName).toEqual(RENAMED);
      const renamed = yield* getRule(rg, ns.namespaceName, wcf.relayName, RENAMED);
      expect(sortedRights(renamed)).toEqual(["Listen"]);
      expect(
        yield* gone(getRule(rg, ns.namespaceName, wcf.relayName, rule.authorizationRuleName)),
      ).toEqual("gone");

      // Removing only the rule deletes it while the WCF relay stays.
      yield* stack.deploy(relayProgram);
      expect(yield* gone(getRule(rg, ns.namespaceName, wcf.relayName, RENAMED))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
