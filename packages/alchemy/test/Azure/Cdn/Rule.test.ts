import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cdn from "@distilled.cloud/azure/cdn";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  FRONT_DOOR_TIMEOUT,
  logLevel,
  profileStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  profileName: string,
  ruleSetName: string,
  ruleName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      ruleSetName,
      ruleName,
    });
  });

const program = (props: { name?: string; value: string; order: number }) =>
  Effect.gen(function* () {
    const { group, profile } = yield* profileStack;
    const ruleSet = yield* Azure.Cdn.RuleSet("Headers", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
    });
    const rule = yield* Azure.Cdn.Rule("FrameOptions", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      ruleSet: ruleSet.ruleSetName,
      name: props.name,
      order: props.order,
      conditions: [
        {
          name: "UrlPath",
          parameters: {
            typeName: "DeliveryRuleUrlPathMatchConditionParameters",
            operator: "BeginsWith",
            matchValues: ["/app"],
            negateCondition: false,
            transforms: [],
          },
        },
      ],
      actions: [
        {
          name: "ModifyResponseHeader",
          parameters: {
            typeName: "DeliveryRuleHeaderActionParameters",
            headerAction: "Overwrite",
            headerName: "X-Frame-Options",
            value: props.value,
          },
        },
      ],
    });
    return { group, profile, ruleSet, rule };
  });

// Front Door Standard profile (<$0.10 per run, 10-20 minutes with the profile
// delete). Free Trial subscriptions cannot create Front Door profiles.
test.provider.skipIf(!runPaidOnly)(
  "rule lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, ruleSet, rule } = yield* stack.deploy(
        program({ value: "DENY", order: 1 }),
      );
      const get = (name: string) =>
        getRule(
          group.resourceGroupName,
          profile.profileName,
          ruleSet.ruleSetName,
          name,
        );
      const observed = yield* get(rule.ruleName);
      expect(observed.properties?.order).toEqual(1);
      expect(observed.properties?.actions?.[0]?.parameters).toMatchObject({
        headerName: "X-Frame-Options",
        value: "DENY",
      });

      // In place: header value and order.
      const updated = yield* stack.deploy(
        program({ value: "SAMEORIGIN", order: 2 }),
      );
      expect(updated.rule.ruleId).toEqual(rule.ruleId);
      const reobserved = yield* get(rule.ruleName);
      expect(reobserved.properties?.order).toEqual(2);
      expect(reobserved.properties?.actions?.[0]?.parameters).toMatchObject({
        value: "SAMEORIGIN",
      });

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemyRuleRenamed", value: "SAMEORIGIN", order: 2 }),
      );
      expect(replaced.rule.ruleName).toEqual("alchemyRuleRenamed");
      expect(yield* waitGone(get(rule.ruleName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.rule.ruleName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
