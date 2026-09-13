import * as AWS from "@/AWS";
import { SecurityGroup, SecurityGroupRule, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
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
                ipProtocol: "tcp",
                fromPort: inlinePort,
                toPort: inlinePort,
                cidrIpv4: "10.0.0.0/16",
              },
            ],
            egress: [
              {
                ipProtocol: "tcp",
                fromPort: inlinePort,
                toPort: inlinePort,
                cidrIpv4: "10.0.0.0/16",
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
  { timeout: 240_000 },
);
