import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:wafv2", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "WafLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const ipSet = yield* AWS.WAFv2.IPSet("lookup-target-ips", { addresses: ["192.0.2.0/24"] });
    const regex = yield* AWS.WAFv2.RegexPatternSet("lookup-target-regex", {
      regularExpressions: ["^/lookup"],
    });
    const rules = yield* AWS.WAFv2.RuleGroup("lookup-target-rules", { capacity: 10 });
    const acl = yield* AWS.WAFv2.WebACL("lookup-target-acl");
    return {
      ipSetName: ipSet.ipSetName.as<string>(),
      ipSetArn: ipSet.ipSetArn.as<string>(),
      regexPatternSetName: regex.regexPatternSetName.as<string>(),
      regexPatternSetArn: regex.regexPatternSetArn.as<string>(),
      ruleGroupName: rules.ruleGroupName.as<string>(),
      ruleGroupArn: rules.ruleGroupArn.as<string>(),
      webAclName: acl.webAclName.as<string>(),
      webAclArn: acl.webAclArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "IP sets, regex pattern sets, rule groups and web ACLs resolve by name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const {
        ipSetName,
        ipSetArn,
        regexPatternSetName,
        regexPatternSetArn,
        ruleGroupName,
        ruleGroupArn,
        webAclName,
        webAclArn,
      } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            ipSet: AWS.WAFv2.IPSet.lookup({ ipSetName }).ipSetArn,
            regex: AWS.WAFv2.RegexPatternSet.lookup({ regexPatternSetName }).regexPatternSetArn,
            rules: AWS.WAFv2.RuleGroup.lookup({ ruleGroupName }).ruleGroupArn,
            acl: AWS.WAFv2.WebACL.lookup({ webAclName, scope: "REGIONAL" }).webAclArn,
          };
        },
        {
          ipSet: ipSetArn,
          regex: regexPatternSetArn,
          rules: ruleGroupArn,
          acl: webAclArn,
        },
      );
      const { IPSets } = yield* wafv2.listIPSets({ Scope: "REGIONAL" });
      expect(IPSets?.map((s) => s.ARN)).toContain(ipSetArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing IP set or web ACL fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-ip-set": AWS.WAFv2.IPSet.lookup({ ipSetName: name }).ipSetArn,
        "missing-acl": AWS.WAFv2.WebACL.lookup({ webAclName: name }).webAclArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an IP set this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.WAFv2.IPSet("lookup-managed", { addresses: ["198.51.100.0/24"] });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-IP-set-consumer", {
              value: AWS.WAFv2.IPSet.lookup({ ipSetName: attrs.ipSetName }).ipSetArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
