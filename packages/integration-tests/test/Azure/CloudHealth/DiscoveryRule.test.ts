import * as Azure from "@alchemy.run/azure";
import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { gone, logLevel, modelProgram, modelWhere, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (rg: string, model: string, discoveryRuleName: string) =>
  Effect.flatMap(modelWhere(rg, model), (where) =>
    cloudhealth.GetDiscoveryRule({ ...where, discoveryRuleName }),
  );

const QUERY = "resources | where type =~ 'microsoft.cloudhealth/healthmodels' | project id";

const program = (props: {
  name: string;
  displayName: string;
  addRecommendedSignals: "Enabled" | "Disabled";
}) =>
  Effect.gen(function* () {
    const { group, model } = yield* modelProgram;
    const where = {
      resourceGroup: group.resourceGroupName,
      healthModel: model.healthModelName,
    };
    const auth = yield* Azure.CloudHealth.AuthenticationSetting("Auth", where);
    const rule = yield* Azure.CloudHealth.DiscoveryRule("Rule", {
      ...where,
      name: props.name,
      displayName: props.displayName,
      authenticationSetting: auth.authenticationSettingName,
      specification: { kind: "ResourceGraphQuery", resourceGraphQuery: QUERY },
      discoverRelationships: "Disabled",
      addRecommendedSignals: props.addRecommendedSignals,
      addResourceHealthSignal: "Disabled",
    });
    return { group, model, auth, rule };
  });

// An empty health model is free; discovery runs one Resource Graph query.
// A few minutes per run.
test.provider(
  "create, update, replace, and delete a health model discovery rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, model, auth, rule } = yield* stack.deploy(
        program({ name: "rule-a", displayName: "v1", addRecommendedSignals: "Disabled" }),
      );
      const rg = group.resourceGroupName;
      const hm = model.healthModelName;
      expect(rule.discoveryRuleName).toEqual("rule-a");
      expect(rule.provisioningState).toEqual("Succeeded");
      const observed = yield* getRule(rg, hm, "rule-a");
      expect(observed.properties?.displayName).toEqual("v1");
      expect(observed.properties?.authenticationSetting).toEqual(auth.authenticationSettingName);
      expect(observed.properties?.specification.kind).toEqual("ResourceGraphQuery");
      expect(observed.properties?.specification.resourceGraphQuery).toEqual(QUERY);
      expect(observed.properties?.discoverRelationships).toEqual("Disabled");
      expect(observed.properties?.addRecommendedSignals).toEqual("Disabled");

      // In place: display name and recommended signals.
      const updated = yield* stack.deploy(
        program({ name: "rule-a", displayName: "v2", addRecommendedSignals: "Enabled" }),
      );
      expect(updated.rule.discoveryRuleId).toEqual(rule.discoveryRuleId);
      const reobserved = yield* getRule(rg, hm, "rule-a");
      expect(reobserved.properties?.displayName).toEqual("v2");
      expect(reobserved.properties?.addRecommendedSignals).toEqual("Enabled");
      expect(reobserved.properties?.specification.resourceGraphQuery).toEqual(QUERY);

      // Replacement: the name is the identity.
      const replaced = yield* stack.deploy(
        program({ name: "rule-b", displayName: "v2", addRecommendedSignals: "Enabled" }),
      );
      expect(replaced.rule.discoveryRuleName).toEqual("rule-b");
      const fresh = yield* getRule(rg, hm, "rule-b");
      expect(fresh.properties?.displayName).toEqual("v2");
      const replacedOld = yield* gone(getRule(rg, hm, "rule-a"));
      expect(replacedOld).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getRule(rg, hm, "rule-b"));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
