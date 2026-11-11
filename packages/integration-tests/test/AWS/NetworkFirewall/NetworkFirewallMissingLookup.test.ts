import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:networkfirewall", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (firewall, firewall policy, rule group).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-firewall": AWS.NetworkFirewall.Firewall.lookup({ firewallName: name })
          .firewallName,
        "missing-firewall-policy": AWS.NetworkFirewall.FirewallPolicy.lookup({
          firewallPolicyName: name,
        }).firewallPolicyName,
        "missing-rule-group": AWS.NetworkFirewall.RuleGroup.lookup({
          ruleGroupArn: `arn:aws:network-firewall:${region}:${accountId}:stateful-rulegroup/missing-lookup`,
        }).ruleGroupName,
      });
    }),
  { tags, timeout: 180_000 },
);
