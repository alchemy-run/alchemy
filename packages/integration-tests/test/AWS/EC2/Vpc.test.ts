import * as AWS from "@alchemy.run/aws";
import { Vpc } from "@alchemy.run/aws/EC2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Test from "./VpcTest.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "create, update, delete vpc",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const vpc = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("TestVpc", {
            cidrBlock: "10.0.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
          });
        }),
      );

      const actualVpc = yield* EC2.describeVpcs({
        VpcIds: [vpc.vpcId],
      });
      expect(actualVpc.Vpcs?.[0]?.VpcId).toEqual(vpc.vpcId);
      expect(actualVpc.Vpcs?.[0]?.CidrBlock).toEqual("10.0.0.0/16");
      expect(actualVpc.Vpcs?.[0]?.State).toEqual("available");

      yield* expectVpcAttribute({
        VpcId: vpc.vpcId,
        Attribute: "enableDnsSupport",
        Value: true,
      });

      yield* expectVpcAttribute({
        VpcId: vpc.vpcId,
        Attribute: "enableDnsHostnames",
        Value: true,
      });

      // Update VPC attributes
      const updatedVpc = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("TestVpc", {
            cidrBlock: "10.0.0.0/16",
            enableDnsSupport: false,
            enableDnsHostnames: false,
          });
        }),
      );

      yield* expectVpcAttribute({
        VpcId: updatedVpc.vpcId,
        Attribute: "enableDnsSupport",
        Value: false,
      });

      yield* expectVpcAttribute({
        VpcId: updatedVpc.vpcId,
        Attribute: "enableDnsHostnames",
        Value: false,
      });

      yield* stack.destroy();

      yield* assertVpcDeleted(vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 15 * 60_000 },
);

test.provider(
  "list enumerates the deployed vpc",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("ListVpc", {
            cidrBlock: "10.0.0.0/16",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Vpc);
      const all = yield* provider.list();

      expect(all.some((v) => v.vpcId === deployed.vpcId)).toBe(true);

      yield* stack.destroy();

      yield* assertVpcDeleted(deployed.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 15 * 60_000 },
);

test.provider(
  "recovers a created vpc whose output was not persisted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        return yield* Vpc("RecoveredVpc", {
          cidrBlock: "10.41.0.0/16",
        });
      });

      const first = yield* stack.deploy(program);

      // Simulate a deploy killed after CreateVpc returned: the row is left in
      // `creating` with no attributes, but the VPC (and its tags) exist.
      const state = yield* yield* State;
      const key = { stack: stack.name, stage: stack.stage, fqn: "RecoveredVpc" };
      const row = yield* state.get(key);
      if (row?.status !== "created") {
        return yield* Effect.die(new Error("Expected a created VPC row"));
      }
      const { attr: _attr, ...rest } = row;
      yield* state.set({ ...key, value: { ...rest, status: "creating" } });

      const recovered = yield* stack.deploy(program);
      expect(recovered.vpcId).toBe(first.vpcId);

      const owned = yield* EC2.describeVpcs({
        Filters: [
          { Name: "tag:alchemy::stack", Values: [stack.name] },
          { Name: "tag:alchemy::stage", Values: [stack.stage] },
          { Name: "tag:alchemy::id", Values: ["RecoveredVpc"] },
        ],
      });
      expect(owned.Vpcs?.map((vpc) => vpc.VpcId)).toEqual([first.vpcId]);

      yield* stack.destroy();

      yield* assertVpcDeleted(first.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 15 * 60_000 },
);

const expectVpcAttribute = Effect.fn(function* (props: {
  VpcId: string;
  Attribute: EC2.VpcAttributeName;
  Value: boolean;
}) {
  yield* EC2.describeVpcAttribute({
    VpcId: props.VpcId,
    Attribute: props.Attribute,
  }).pipe(
    Effect.tap(Effect.logDebug),
    Effect.flatMap((result: any) =>
      result[`${props.Attribute[0].toUpperCase()}${props.Attribute.slice(1)}`]?.Value ===
      props.Value
        ? Effect.succeed(result)
        : Effect.fail(new VpcAttributeStale()),
    ),
    Effect.retry({
      while: (e) => e._tag === "VpcAttributeStale",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(8)]),
    }),
  );
});

class VpcAttributeStale extends Data.TaggedError("VpcAttributeStale") {}

class VpcStillExists extends Data.TaggedError("VpcStillExists") {}

export const assertVpcDeleted = Effect.fn(function* (vpcId: string) {
  yield* EC2.describeVpcs({
    VpcIds: [vpcId],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new VpcStillExists())),
    Effect.retry({
      while: (e) => e._tag === "VpcStillExists",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(8)]),
    }),
    Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
  );
});
