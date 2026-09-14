import * as AWS from "@/AWS";
import { SecurityGroup, SecurityGroupRule, Vpc } from "@/AWS/EC2";
import type { SecurityGroupRuleData } from "@/AWS/EC2/SecurityGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertSecurityGroupGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "creates and updates explicitly empty egress",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (egress: SecurityGroupRuleData[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("EmptyEgressVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const sg = yield* SecurityGroup("EmptyEgressSg", {
              vpcId: vpc.vpcId,
              egress,
            });
            return { vpc, sg };
          }),
        );
      const created = yield* deploy([]);
      const initial = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(initial.SecurityGroupRules).toEqual([]);
      yield* deploy([
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "0.0.0.0/0",
        },
      ]);
      const updated = yield* deploy([]);
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const final = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(final.SecurityGroupRules).toEqual([]);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);

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
  "preserves standalone rules across a group tag update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (label: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("StandaloneVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const sg = yield* SecurityGroup("StandaloneSg", {
              vpcId: vpc.vpcId,
              tags: { Label: label },
            });
            const rule = yield* SecurityGroupRule("StandaloneIngress", {
              groupId: sg.groupId,
              type: "ingress",
              ipProtocol: "tcp",
              fromPort: 443,
              toPort: 443,
              cidrIpv4: "10.0.0.0/16",
            });
            return { vpc, sg, rule };
          }),
        );
      const created = yield* deploy("before");
      const updated = yield* deploy("after");
      expect(updated.rule.securityGroupRuleId).toBe(
        created.rule.securityGroupRuleId,
      );
      const rules = yield* ec2.describeSecurityGroupRules({
        SecurityGroupRuleIds: [created.rule.securityGroupRuleId],
      });
      expect(rules.SecurityGroupRules?.[0]?.GroupId).toBe(created.sg.groupId);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);

test.provider(
  "repairs inline drift without replacing unchanged rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("InlineDriftVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const sg = yield* SecurityGroup("InlineDriftSg", {
              vpcId: vpc.vpcId,
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 443,
                  toPort: 443,
                  cidrIpv4: "10.0.0.0/16",
                },
              ],
              egress: [],
            });
            return { vpc, sg };
          }),
        );
      const created = yield* deploy();
      const originalRuleId = created.sg.ingressRules?.[0]?.securityGroupRuleId;
      yield* ec2.authorizeSecurityGroupIngress({
        GroupId: created.sg.groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "10.0.0.0/16" }],
          },
        ],
      });
      const updated = yield* deploy();
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const rules = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(rules.SecurityGroupRules).toEqual([
        expect.objectContaining({
          SecurityGroupRuleId: originalRuleId,
          FromPort: 443,
        }),
      ]);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);
