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

const getRuleSet = (
  resourceGroupName: string,
  profileName: string,
  ruleSetName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetRuleSet({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      ruleSetName,
    });
  });

const program = (name?: string) =>
  Effect.gen(function* () {
    const { group, profile } = yield* profileStack;
    const ruleSet = yield* Azure.Cdn.RuleSet("Headers", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      name,
    });
    return { group, profile, ruleSet };
  });

// Front Door Standard profile (<$0.10 per run, 10-20 minutes with the profile
// delete). Free Trial subscriptions cannot create Front Door profiles. Rule
// sets have no mutable settings, so the test covers create, an idempotent
// redeploy, replacement, and delete.
test.provider.skipIf(!runPaidOnly)(
  "rule set lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, ruleSet } = yield* stack.deploy(program());
      const get = (name: string) =>
        getRuleSet(group.resourceGroupName, profile.profileName, name);
      expect(ruleSet.ruleSetName).toMatch(/^[a-z][a-z0-9]*$/);
      const observed = yield* get(ruleSet.ruleSetName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      const again = yield* stack.deploy(program());
      expect(again.ruleSet.ruleSetId).toEqual(ruleSet.ruleSetId);

      // Replacement: a new name.
      const replaced = yield* stack.deploy(program("alchemyRenamed"));
      expect(replaced.ruleSet.ruleSetName).toEqual("alchemyRenamed");
      expect(yield* waitGone(get(ruleSet.ruleSetName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.ruleSet.ruleSetName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
