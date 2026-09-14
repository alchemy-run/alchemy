import * as AWS from "@/AWS";
import { DefaultSecurityGroup, Vpc } from "@/AWS/EC2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";
import * as Test from "./VpcTest.ts";
import { assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });
const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("AWS creates the default group with its initial rules", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const vpc = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Vpc("DefaultSecurityGroupInitialVpc", {
          cidrBlock: "10.43.0.0/16",
        });
      }),
    );

    const group = yield* findDefaultGroup(vpc.vpcId);
    yield* expectRules(
      group.GroupId!,
      [{ IpProtocol: "-1", ReferencedGroupInfo: { GroupId: group.GroupId! } }],
      [{ IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" }],
    );

    yield* stack.destroy();
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);

// This changes the AWS-created default security group only inside the VPC this
// test creates and destroys.
test.provider(
  "manages a temporary VPC's default security group without deleting it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The VPC output is consumed in this same first deployment. This proves
      // that the default group can be found and closed without a second deploy.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          const defaultSecurityGroup = yield* DefaultSecurityGroup(
            "DefaultSecurityGroup",
            {
              vpcId: vpc.vpcId,
              ingress: [],
              egress: [],
            },
          );
          return { vpc, defaultSecurityGroup };
        }),
      );

      const defaultGroup = yield* findDefaultGroup(initial.vpc.vpcId);
      expect(initial.defaultSecurityGroup.groupId).toEqual(
        defaultGroup.GroupId,
      );
      yield* expectRules(initial.defaultSecurityGroup.groupId, [], []);

      // A second identical deployment verifies idempotence against AWS readback.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          return yield* DefaultSecurityGroup("DefaultSecurityGroup", {
            vpcId: vpc.vpcId,
            ingress: [],
            egress: [],
          });
        }),
      );
      yield* expectRules(initial.defaultSecurityGroup.groupId, [], []);

      // A changed complete declaration replaces the rule set.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          return yield* DefaultSecurityGroup("DefaultSecurityGroup", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.42.0.0/16",
              },
            ],
            egress: [],
          });
        }),
      );
      yield* expectRules(
        initial.defaultSecurityGroup.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.42.0.0/16",
          },
        ],
        [],
      );

      // Removing the Alchemy resource must not delete the AWS-owned group or
      // restore its initial AWS rules.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
        }),
      );
      const preserved = yield* findDefaultGroup(initial.vpc.vpcId);
      expect(preserved.GroupId).toEqual(initial.defaultSecurityGroup.groupId);
      yield* expectRules(
        initial.defaultSecurityGroup.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.42.0.0/16",
          },
        ],
        [],
      );

      yield* stack.destroy();
      yield* assertVpcGone(initial.vpc.vpcId);
    }).pipe(logLevel),
);

const findDefaultGroup = Effect.fn(function* (vpcId: string) {
  const result = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const group = result.SecurityGroups?.[0];
  if (!group?.GroupId) {
    throw new Error(`Default group for ${vpcId} was not found`);
  }
  return group;
});

const readRules = (groupId: string) =>
  EC2.describeSecurityGroupRules
    .items({ Filters: [{ Name: "group-id", Values: [groupId] }] })
    .pipe(
      Stream.runCollect,
      Effect.map((rules) => Array.from(rules)),
    );

const expectRules = Effect.fn(function* (
  groupId: string,
  ingress: Partial<EC2.SecurityGroupRule>[],
  egress: Partial<EC2.SecurityGroupRule>[],
) {
  const rules = yield* readRules(groupId);
  expect(rules.filter((rule) => !rule.IsEgress)).toEqual(
    ingress.map((rule) => expect.objectContaining(rule)),
  );
  expect(rules.filter((rule) => rule.IsEgress)).toEqual(
    egress.map((rule) => expect.objectContaining(rule)),
  );
});
