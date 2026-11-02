import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Security groups and rules are free, so the suite is ungated.
const options = { tags: stackitTags("iaas", "securitygrouprule"), timeout: 300_000 } as const;

const observe = (
  projectId: string,
  region: string,
  securityGroupId: string,
  securityGroupRuleId: string,
) =>
  iaas
    .getSecurityGroupRule({ projectId, region, securityGroupId, securityGroupRuleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (
  projectId: string,
  region: string,
  securityGroupId: string,
  securityGroupRuleId: string,
) =>
  observe(projectId, region, securityGroupId, securityGroupRuleId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (rule) => rule === "gone",
      times: 10,
    }),
    Effect.map((rule) => expect(rule).toEqual("gone")),
  );

const groupWithRule = (rule: Omit<Stackit.IaaS.SecurityGroupRuleProps, "securityGroupId">) =>
  Effect.gen(function* () {
    const group = yield* Stackit.IaaS.SecurityGroup("RuleGroup", {});
    const created = yield* Stackit.IaaS.SecurityGroupRule("Ssh", {
      securityGroupId: group.securityGroupId,
      ...rule,
    });
    return { group, rule: created };
  });

test.provider(
  "create, replace and delete a security group rule",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        groupWithRule({
          direction: "ingress",
          protocol: "tcp",
          portRange: { min: 22, max: 22 },
          ipRange: "203.0.113.0/24",
          description: "ssh",
        }),
      );
      const securityGroupId = first.group.securityGroupId;
      expect(first.rule.securityGroupRuleId).toEqual(expect.any(String));
      expect(first.rule.securityGroupId).toEqual(securityGroupId);
      expect(first.rule.direction).toEqual("ingress");
      expect(first.rule.ethertype).toEqual("IPv4");
      expect(first.rule.protocolName).toEqual("tcp");
      expect(first.rule.portRange).toEqual({ min: 22, max: 22 });

      const fetched = yield* iaas.getSecurityGroupRule({
        projectId,
        region,
        securityGroupId,
        securityGroupRuleId: first.rule.securityGroupRuleId,
      });
      expect(fetched.direction).toEqual("ingress");
      expect(fetched.ipRange).toEqual("203.0.113.0/24");
      expect(fetched.portRange).toEqual({ min: 22, max: 22 });
      expect(fetched.description).toEqual("ssh");

      // Rules are immutable: a new port replaces the rule (create first).
      const second = yield* stack.deploy(
        groupWithRule({
          direction: "ingress",
          protocol: "tcp",
          portRange: { min: 2222, max: 2222 },
          ipRange: "203.0.113.0/24",
          description: "ssh",
        }),
      );
      expect(second.group.securityGroupId).toEqual(securityGroupId);
      expect(second.rule.securityGroupRuleId).not.toEqual(first.rule.securityGroupRuleId);
      expect(second.rule.portRange).toEqual({ min: 2222, max: 2222 });
      yield* expectGone(projectId, region, securityGroupId, first.rule.securityGroupRuleId);

      // A description-only change deletes the old rule first.
      const third = yield* stack.deploy(
        groupWithRule({
          direction: "ingress",
          protocol: "tcp",
          portRange: { min: 2222, max: 2222 },
          ipRange: "203.0.113.0/24",
          description: "ssh on 2222",
        }),
      );
      expect(third.rule.securityGroupRuleId).not.toEqual(second.rule.securityGroupRuleId);
      expect(third.rule.description).toEqual("ssh on 2222");
      yield* expectGone(projectId, region, securityGroupId, second.rule.securityGroupRuleId);

      const { items } = yield* iaas.listSecurityGroupRules({ projectId, region, securityGroupId });
      expect(items.map((rule) => rule.id)).toContain(third.rule.securityGroupRuleId);

      yield* stack.destroy();
      yield* expectGone(projectId, region, securityGroupId, third.rule.securityGroupRuleId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "icmp and remote security group rules",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const web = yield* Stackit.IaaS.SecurityGroup("Web", {});
          const db = yield* Stackit.IaaS.SecurityGroup("Db", {});
          const ping = yield* Stackit.IaaS.SecurityGroupRule("Ping", {
            securityGroupId: web.securityGroupId,
            direction: "ingress",
            protocol: "icmp",
            icmpParameters: { type: 8, code: 0 },
            ipRange: "0.0.0.0/0",
          });
          const fromWeb = yield* Stackit.IaaS.SecurityGroupRule("DbFromWeb", {
            securityGroupId: db.securityGroupId,
            direction: "ingress",
            protocol: "tcp",
            portRange: { min: 5432, max: 5432 },
            remoteSecurityGroupId: web.securityGroupId,
          });
          return { web, db, ping, fromWeb };
        }),
      );

      expect(deployed.ping.icmpParameters).toEqual({ type: 8, code: 0 });
      expect(deployed.fromWeb.remoteSecurityGroupId).toEqual(deployed.web.securityGroupId);

      const fetched = yield* iaas.getSecurityGroupRule({
        projectId,
        region,
        securityGroupId: deployed.db.securityGroupId,
        securityGroupRuleId: deployed.fromWeb.securityGroupRuleId,
      });
      expect(fetched.remoteSecurityGroupId).toEqual(deployed.web.securityGroupId);

      yield* stack.destroy();
      yield* expectGone(
        projectId,
        region,
        deployed.web.securityGroupId,
        deployed.ping.securityGroupRuleId,
      );
    }).pipe(logLevel),
  options,
);
