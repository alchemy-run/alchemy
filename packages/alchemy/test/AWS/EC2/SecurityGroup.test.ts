import * as AWS from "@/AWS";
import { SecurityGroup, SecurityGroupRule, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { MinimumLogLevel } from "effect/References";
import { assertSecurityGroupGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const describeRules = (groupId: string) =>
  EC2.describeSecurityGroupRules({
    Filters: [{ Name: "group-id", Values: [groupId] }],
  }).pipe(Effect.map((result) => result.SecurityGroupRules ?? []));

test.provider("list enumerates the deployed Security Group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, sg } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListSgVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const sg = yield* SecurityGroup("ListSg", {
          vpcId: vpc.vpcId,
        });
        return { vpc, sg };
      }),
    );

    const provider = yield* Provider.findProvider(SecurityGroup);
    const all = yield* provider.list();

    expect(all.some((x) => x.groupId === sg.groupId)).toBe(true);

    yield* stack.destroy();

    yield* assertSecurityGroupGone(sg.groupId);
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);

test.provider(
  "reconciles inline rules without taking over standalone rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (inlinePort: number, standalone = true) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("MixedRulesVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const sg = yield* SecurityGroup("MixedRulesSg", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "6",
                fromPort: inlinePort,
                toPort: inlinePort,
                cidrIpv4: "10.0.0.7/16",
              },
              {
                ipProtocol: "58",
                fromPort: -1,
                toPort: -1,
                cidrIpv6: "2001:0db8:0:0:0:0:0:5/64",
              },
            ],
            egress: [
              {
                ipProtocol: "6",
                fromPort: inlinePort,
                toPort: inlinePort,
                cidrIpv4: "10.0.0.7/16",
              },
            ],
          });
          const ingressRule = standalone
            ? yield* SecurityGroupRule("StandaloneIngress", {
                groupId: sg.groupId,
                type: "ingress",
                ipProtocol: "tcp",
                fromPort: 5432,
                toPort: 5432,
                cidrIpv4: "10.0.0.0/16",
              })
            : undefined;
          const egressRule = standalone
            ? yield* SecurityGroupRule("StandaloneEgress", {
                groupId: sg.groupId,
                type: "egress",
                ipProtocol: "udp",
                fromPort: 53,
                toPort: 53,
                cidrIpv4: "10.0.0.0/16",
              })
            : undefined;
          return { egressRule, ingressRule, sg, vpc };
        });

      const deployed = yield* stack.deploy(makeStack(443));
      const declared = (yield* describeRules(deployed.sg.groupId)).find(
        (rule) =>
          rule.SecurityGroupRuleId ===
          deployed.ingressRule?.securityGroupRuleId,
      )!;
      // Even copied ownership tags do not delegate an undeclared physical rule.
      const rogue = yield* EC2.authorizeSecurityGroupIngress({
        GroupId: deployed.sg.groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
        ],
        TagSpecifications: [
          { ResourceType: "security-group-rule", Tags: declared.Tags },
        ],
      });
      const rogueId = rogue.SecurityGroupRules![0]!.SecurityGroupRuleId!;
      const stale = yield* EC2.authorizeSecurityGroupEgress({
        GroupId: deployed.sg.groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 25,
            ToPort: 25,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
        ],
        TagSpecifications: [
          {
            ResourceType: "security-group-rule",
            Tags: [{ Key: "alchemy::id", Value: "RemovedRule" }],
          },
        ],
      });
      const staleId = stale.SecurityGroupRules![0]!.SecurityGroupRuleId!;
      expect(
        (yield* describeRules(deployed.sg.groupId).pipe(
          Effect.repeat({
            until: (rules) =>
              rules.some((rule) => rule.SecurityGroupRuleId === rogueId) &&
              rules.some((rule) => rule.SecurityGroupRuleId === staleId),
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        )).some((rule) => rule.SecurityGroupRuleId === rogueId),
      ).toBe(true);
      expect(
        (yield* stack.plan(makeStack(443))).resources.MixedRulesSg?.action,
      ).toBe("update");
      yield* stack.deploy(makeStack(443));
      const repaired = yield* describeRules(deployed.sg.groupId);
      expect(
        repaired.some((rule) =>
          [rogueId, staleId].includes(rule.SecurityGroupRuleId!),
        ),
      ).toBe(false);
      expect(
        repaired.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
            deployed.ingressRule?.securityGroupRuleId,
        ),
      ).toBe(true);
      expect(
        repaired.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
            deployed.egressRule?.securityGroupRuleId,
        ),
      ).toBe(true);
      expect(
        (yield* stack.plan(makeStack(443))).resources.MixedRulesSg?.action,
      ).toBe("noop");
      const updated = yield* stack.deploy(makeStack(8443));

      expect(updated.ingressRule?.securityGroupRuleId).toEqual(
        deployed.ingressRule?.securityGroupRuleId,
      );
      expect(updated.egressRule?.securityGroupRuleId).toEqual(
        deployed.egressRule?.securityGroupRuleId,
      );

      const updatedRules = yield* describeRules(updated.sg.groupId);
      expect(
        updatedRules.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
              updated.ingressRule?.securityGroupRuleId &&
            rule.Tags?.some((tag) => tag.Key === "alchemy::id"),
        ),
      ).toBe(true);
      expect(
        updatedRules.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
              updated.egressRule?.securityGroupRuleId &&
            rule.Tags?.some((tag) => tag.Key === "alchemy::id"),
        ),
      ).toBe(true);
      expect(
        updatedRules.filter(
          (rule) => rule.FromPort === 8443 && rule.ToPort === 8443,
        ),
      ).toHaveLength(2);
      expect(updatedRules.some((rule) => rule.FromPort === 443)).toBe(false);

      yield* stack.deploy(makeStack(8443, false));
      const finalRules = yield* describeRules(updated.sg.groupId);
      expect(
        finalRules.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
              updated.ingressRule?.securityGroupRuleId ||
            rule.SecurityGroupRuleId ===
              updated.egressRule?.securityGroupRuleId,
        ),
      ).toBe(false);
      expect(
        finalRules.filter(
          (rule) => rule.FromPort === 8443 && rule.ToPort === 8443,
        ),
      ).toHaveLength(2);

      yield* stack.destroy();
      yield* assertSecurityGroupGone(updated.sg.groupId);
      yield* assertVpcGone(updated.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "creates dual-stack permissions and keeps unchanged rules stable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        const vpc = yield* Vpc("DualStackVpc", { cidrBlock: "10.0.0.0/16" });
        const permission = {
          ipProtocol: "6",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.0.0.7/16",
          cidrIpv6: "2001:0db8:0:0:0:0:0:5/64",
          description: "dual-stack HTTPS",
        };
        const sg = yield* SecurityGroup("DualStackSg", {
          vpcId: vpc.vpcId,
          ingress: [
            permission,
            { ipProtocol: "58", cidrIpv6: "2001:db8::/64" },
          ],
          egress: [permission],
        });
        return { sg, vpc };
      });
      const { sg, vpc } = yield* stack.deploy(program);
      const rules = yield* describeRules(sg.groupId);
      expect(rules).toHaveLength(5);
      for (const isEgress of [false, true]) {
        const https = rules.filter(
          (rule) => rule.IsEgress === isEgress && rule.IpProtocol === "tcp",
        );
        expect(https).toHaveLength(2);
        expect(https.some((rule) => rule.CidrIpv4 === "10.0.0.0/16")).toBe(
          true,
        );
        expect(https.some((rule) => rule.CidrIpv6 === "2001:db8::/64")).toBe(
          true,
        );
      }
      expect((yield* stack.plan(program)).resources.DualStackSg?.action).toBe(
        "noop",
      );
      yield* stack.deploy(program);
      expect(
        (yield* describeRules(sg.groupId))
          .map((rule) => rule.SecurityGroupRuleId)
          .sort(),
      ).toEqual(rules.map((rule) => rule.SecurityGroupRuleId).sort());
      yield* stack.destroy();
      yield* assertSecurityGroupGone(sg.groupId);
      yield* assertVpcGone(vpc.vpcId);
    }),
  { timeout: 120_000 },
);

const securityGroupStack = (props: { egress?: [] }) =>
  Effect.gen(function* () {
    const vpc = yield* Vpc("EmptyEgressVpc", {
      cidrBlock: "10.0.0.0/16",
    });
    const sg = yield* SecurityGroup("EmptyEgressSg", {
      vpcId: vpc.vpcId,
      ...props,
    });
    return { sg, vpc };
  });

const describeEgress = (groupId: string) =>
  EC2.describeSecurityGroupRules({
    Filters: [{ Name: "group-id", Values: [groupId] }],
  }).pipe(
    Effect.map((result) =>
      (result.SecurityGroupRules ?? []).filter((rule) => rule.IsEgress),
    ),
  );

test.provider(
  "distinguishes explicit empty egress from omitted egress",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Creating with explicitly empty egress removes AWS's default allow-all rule.
      const noOutbound = yield* stack.deploy(
        securityGroupStack({ egress: [] }),
      );
      expect(yield* describeEgress(noOutbound.sg.groupId)).toEqual([]);

      // Redeploying the same configuration must keep outbound access disabled.
      const stillNoOutbound = yield* stack.deploy(
        securityGroupStack({ egress: [] }),
      );
      expect(yield* describeEgress(stillNoOutbound.sg.groupId)).toEqual([]);

      // Omitting the egress property restores default allow-all IPv4 access.
      const defaultOutbound = yield* stack.deploy(securityGroupStack({}));
      const defaultEgress = yield* describeEgress(defaultOutbound.sg.groupId);
      expect(defaultEgress).toHaveLength(1);
      expect(defaultEgress[0]?.IpProtocol).toEqual("-1");
      expect(defaultEgress[0]?.CidrIpv4).toEqual("0.0.0.0/0");

      // Switching back to explicitly empty egress removes allow-all again.
      const outboundDisabledAgain = yield* stack.deploy(
        securityGroupStack({ egress: [] }),
      );
      expect(yield* describeEgress(outboundDisabledAgain.sg.groupId)).toEqual(
        [],
      );

      yield* stack.destroy();
      yield* assertSecurityGroupGone(outboundDisabledAgain.sg.groupId);
      yield* assertVpcGone(outboundDisabledAgain.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
