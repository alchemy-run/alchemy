import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as ufw from "@distilled.cloud/stackit/ufw";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  deleteOutOfBand,
  expectRuleGone,
  securityRuleProduct,
  type Scope,
  waitForActive,
} from "./rules.ts";

const { test } = makeStackitTest();

// A rule has no SKU, and its target is a security group, which is free: EUR 0, ungated.
const options = { tags: stackitTags("unifiedfirewall", "rule"), timeout: 300_000 } as const;

const traffic = {
  type: "SecurityRule",
  sourceIP: "192.0.2.0/24",
  direction: "ingress",
  etherType: "IPv4",
  protocol: "TCP",
  portRange: "8080-8090",
} as const;

/** A rule on a security group, with the group in the same stack. */
const ruleOnGroup = (
  groupId: string,
  product: string,
  props: Partial<Pick<Stackit.UnifiedFirewall.RuleProps, "description" | "sourceIP">> = {},
) =>
  Effect.gen(function* () {
    const group = yield* Stackit.IaaS.SecurityGroup(groupId, {});
    const rule = yield* Stackit.UnifiedFirewall.Rule("Rule", {
      product,
      instanceId: group.securityGroupId,
      securityGroupId: group.securityGroupId,
      ...traffic,
      ...props,
    });
    return { group, rule };
  });

const getRule = (scope: Scope, ruleId: string) =>
  ufw.getRule({ projectId: scope.projectId, regionId: scope.region, ruleId });

test.provider(
  "create a rule, update it in place, and delete only it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      const product = yield* securityRuleProduct(region);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        ruleOnGroup("UfwRuleGroup", product, { description: "alchemy test rule" }),
      );
      const ruleId = created.rule.ruleId;
      expect(ruleId).toEqual(expect.any(String));
      expect(created.rule.status).toEqual("Active");
      expect(created.rule.projectId).toEqual(projectId);
      expect(created.rule.region).toEqual(region);

      const fetched = yield* getRule(scope, ruleId);
      expect(fetched).toMatchObject({
        status: "Active",
        product,
        instanceId: created.group.securityGroupId,
        type: "SecurityRule",
        sourceIP: "192.0.2.0/24",
        portRange: "8080-8090",
        description: "alchemy test rule",
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        ruleOnGroup("UfwRuleGroup", product, { description: "alchemy test rule" }),
      );
      expect(plan.resources.Rule).toMatchObject({ action: "noop" });

      // The range updates in place, under the same id, and its neighbours stay.
      const moved = yield* stack.deploy(
        ruleOnGroup("UfwRuleGroup", product, {
          description: "alchemy test rule",
          sourceIP: "198.51.100.0/24",
        }),
      );
      expect(moved.rule.ruleId).toEqual(ruleId);
      const changed = yield* getRule(scope, ruleId);
      expect(changed).toMatchObject({
        status: "Active",
        sourceIP: "198.51.100.0/24",
        portRange: "8080-8090",
        description: "alchemy test rule",
      });
      expect(changed.protocol?.toLowerCase()).toEqual("tcp");
      expect(changed.direction?.toLowerCase()).toEqual("ingress");

      // A rule someone else added on the same group survives this rule's removal.
      const { refId: foreignId } = yield* ufw.createRule({
        projectId,
        regionId: region,
        product,
        instanceId: created.group.securityGroupId,
        securityGroupId: created.group.securityGroupId,
        ...traffic,
        sourceIP: "203.0.113.0/24",
      });
      yield* Effect.gen(function* () {
        yield* waitForActive(scope, foreignId!);
        yield* stack.deploy(Stackit.IaaS.SecurityGroup("UfwRuleGroup", {}));
        yield* expectRuleGone(scope, ruleId);
        const survivor = yield* getRule(scope, foreignId!);
        expect(survivor.sourceIP).toEqual("203.0.113.0/24");
      }).pipe(Effect.ensuring(deleteOutOfBand(scope, foreignId!)));
      yield* expectRuleGone(scope, foreignId!);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "what the API can't update replaces the rule, and the old one goes",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      const product = yield* securityRuleProduct(region);
      yield* stack.destroy();

      const first = yield* stack.deploy(
        ruleOnGroup("UfwReplaceGroup", product, { description: "first" }),
      );

      // Same target and traffic: the old rule goes first.
      const described = yield* stack.deploy(
        ruleOnGroup("UfwReplaceGroup", product, { description: "second" }),
      );
      expect(described.rule.ruleId).not.toEqual(first.rule.ruleId);
      yield* expectRuleGone(scope, first.rule.ruleId);
      const fetched = yield* getRule(scope, described.rule.ruleId);
      expect(fetched.description).toEqual("second");

      // A new target comes from a new group.
      const retargeted = yield* stack.deploy(
        ruleOnGroup("UfwReplaceOtherGroup", product, { description: "second" }),
      );
      expect(retargeted.rule.ruleId).not.toEqual(described.rule.ruleId);
      expect(retargeted.rule.instanceId).toEqual(retargeted.group.securityGroupId);
      yield* expectRuleGone(scope, described.rule.ruleId);

      yield* stack.destroy();
      yield* expectRuleGone(scope, retargeted.rule.ruleId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a matching rule found without state is unowned until adopted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const scope = { projectId, region };
      const product = yield* securityRuleProduct(region);
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          return { group: yield* Stackit.IaaS.SecurityGroup("UfwForeignGroup", {}) };
        }),
      );
      const { refId } = yield* ufw.createRule({
        projectId,
        regionId: region,
        product,
        instanceId: group.securityGroupId,
        securityGroupId: group.securityGroupId,
        ...traffic,
      });
      yield* Effect.gen(function* () {
        yield* waitForActive(scope, refId!);
        const resource = ruleOnGroup("UfwForeignGroup", product);

        const refused = yield* stack.deploy(resource).pipe(Effect.flip);
        expect(refused._tag).toEqual("OwnedBySomeoneElse");
        const untouched = yield* getRule(scope, refId!);
        expect(untouched.status).toEqual("Active");

        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            const adoptedGroup = yield* Stackit.IaaS.SecurityGroup("UfwForeignGroup", {});
            const rule = yield* Stackit.UnifiedFirewall.Rule("Rule", {
              product,
              instanceId: adoptedGroup.securityGroupId,
              securityGroupId: adoptedGroup.securityGroupId,
              ...traffic,
            }).pipe(adopt(true));
            return { group: adoptedGroup, rule };
          }),
        );
        expect(adopted.rule.ruleId).toEqual(refId);

        // The stack owns it now, so destroying it deletes it.
        yield* stack.destroy();
        yield* expectRuleGone(scope, refId!);
      }).pipe(Effect.ensuring(deleteOutOfBand(scope, refId!)));
    }).pipe(logLevel),
  options,
);
