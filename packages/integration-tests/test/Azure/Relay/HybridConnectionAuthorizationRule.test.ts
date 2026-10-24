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
  hybridConnectionName: string,
  authorizationRuleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    relay.GetHybridConnectionAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      hybridConnectionName,
      authorizationRuleName,
    }),
  );

const RENAMED = "alchemy-relay-hc-rule-renamed";

const connectionProgram = Effect.gen(function* () {
  const { group, ns } = yield* namespaceProgram;
  const hc = yield* Azure.Relay.HybridConnection("Connection", {
    resourceGroup: group.resourceGroupName,
    namespace: ns.namespaceName,
  });
  return { group, ns, hc };
});

const program = (props: { rights: Azure.Relay.RelayAccessRight[]; name?: string }) =>
  Effect.gen(function* () {
    const { group, ns, hc } = yield* connectionProgram;
    const rule = yield* Azure.Relay.HybridConnectionAuthorizationRule("Listener", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      hybridConnection: hc.hybridConnectionName,
      name: props.name,
      rights: props.rights,
    });
    return { group, ns, hc, rule };
  });

const sortedRights = (rule: relay.GetHybridConnectionAuthorizationRuleResponse) =>
  [...(rule.properties?.rights ?? [])].sort();

// Relay namespace + hybrid connection with no listeners (~$0) + one SAS
// rule (free); a few minutes.
test.provider(
  "create, update, replace, and delete a relay hybrid connection authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, hc, rule } = yield* stack.deploy(program({ rights: ["Listen"] }));
      const rg = group.resourceGroupName;
      const hcName = hc.hybridConnectionName;
      expect(rule.hybridConnectionName).toEqual(hcName);
      expect(rule.rights).toEqual(["Listen"]);
      expect(Redacted.isRedacted(rule.primaryConnectionString)).toEqual(true);
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(`EntityPath=${hcName}`);
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        `SharedAccessKeyName=${rule.authorizationRuleName}`,
      );
      const observed = yield* getRule(rg, ns.namespaceName, hcName, rule.authorizationRuleName);
      expect(sortedRights(observed)).toEqual(["Listen"]);

      // In place: add Send.
      const updated = yield* stack.deploy(program({ rights: ["Listen", "Send"] }));
      expect(updated.rule.authorizationRuleName).toEqual(rule.authorizationRuleName);
      expect(updated.rule.rights).toEqual(["Listen", "Send"]);
      const reobserved = yield* getRule(rg, ns.namespaceName, hcName, rule.authorizationRuleName);
      expect(sortedRights(reobserved)).toEqual(["Listen", "Send"]);

      // Replacement: an explicit name replaces the rule.
      const replaced = yield* stack.deploy(program({ rights: ["Send"], name: RENAMED }));
      expect(replaced.rule.authorizationRuleName).toEqual(RENAMED);
      const renamed = yield* getRule(rg, ns.namespaceName, hcName, RENAMED);
      expect(sortedRights(renamed)).toEqual(["Send"]);
      expect(
        yield* gone(getRule(rg, ns.namespaceName, hcName, rule.authorizationRuleName)),
      ).toEqual("gone");

      // Removing only the rule deletes it while the hybrid connection stays.
      yield* stack.deploy(connectionProgram);
      expect(yield* gone(getRule(rg, ns.namespaceName, hcName, RENAMED))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
