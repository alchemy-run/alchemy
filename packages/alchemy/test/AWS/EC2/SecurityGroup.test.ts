import * as AWS from "@/AWS";
import { SecurityGroup, Vpc } from "@/AWS/EC2";
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
      expect(yield* describeEgress(outboundDisabledAgain.sg.groupId)).toEqual([]);

      yield* stack.destroy();
      yield* assertSecurityGroupGone(outboundDisabledAgain.sg.groupId);
      yield* assertVpcGone(outboundDisabledAgain.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
