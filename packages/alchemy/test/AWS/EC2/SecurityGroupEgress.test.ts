import * as AWS from "@/AWS";
import { SecurityGroup, Vpc } from "@/AWS/EC2";
import * as Alchemy from "@/index.ts";
import * as State from "@/State";
import * as Core from "@/Test/Core";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertSecurityGroupGone, assertVpcGone } from "./Gone.ts";

const providers = AWS.providers();
const state = State.localState();
const stackName = "security-group-empty-egress-live-test";
const options = { providers, state };
const { afterAll, beforeAll, deploy, destroy, test } = Test.make({
  providers,
  state,
});

const Stack = (egress?: []) =>
  Alchemy.Stack(
    stackName,
    { providers, state },
    Effect.gen(function* () {
      const vpc = yield* Vpc("EmptyEgressVpc", {
        cidrBlock: "10.0.0.0/16",
      });
      const sg = yield* SecurityGroup("EmptyEgressSg", {
        vpcId: vpc.vpcId,
        ...(egress === undefined ? {} : { egress }),
      });
      return { sg, vpc };
    }),
  );

const describeEgress = (groupId: string) =>
  Core.withProviders(
    EC2.describeSecurityGroupRules({
      Filters: [{ Name: "group-id", Values: [groupId] }],
    }).pipe(
      Effect.map((result) =>
        (result.SecurityGroupRules ?? []).filter((rule) => rule.IsEgress),
      ),
    ),
    options,
    stackName,
  );

const deployed = beforeAll(
  Effect.gen(function* () {
    yield* destroy(Stack([]));
    return yield* deploy(Stack([]));
  }),
  { timeout: 240_000 },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { sg, vpc } = yield* deployed;
    yield* destroy(Stack([]));
    yield* Core.withProviders(
      Effect.all(
        [assertSecurityGroupGone(sg.groupId), assertVpcGone(vpc.vpcId)],
        { concurrency: 2, discard: true },
      ),
      options,
      stackName,
    );
  }),
  { timeout: 240_000 },
);

test(
  "distinguishes explicit empty egress from omitted egress",
  Effect.gen(function* () {
    const initial = yield* deployed;
    expect(yield* describeEgress(initial.sg.groupId)).toEqual([]);

    const unchanged = yield* deploy(Stack([]));
    expect(yield* describeEgress(unchanged.sg.groupId)).toEqual([]);

    const defaulted = yield* deploy(Stack());
    const defaultEgress = yield* describeEgress(defaulted.sg.groupId);
    expect(defaultEgress).toHaveLength(1);
    expect(defaultEgress[0]?.IpProtocol).toEqual("-1");
    expect(defaultEgress[0]?.CidrIpv4).toEqual("0.0.0.0/0");

    const restored = yield* deploy(Stack([]));
    expect(yield* describeEgress(restored.sg.groupId)).toEqual([]);

    yield* Effect.logInfo(
      `Inspect in AWS: VPC ${restored.vpc.vpcId}, security group ${restored.sg.groupId}`,
    );
  }),
  { timeout: 240_000 },
);
