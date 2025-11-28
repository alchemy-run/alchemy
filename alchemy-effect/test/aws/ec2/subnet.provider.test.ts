import * as AWS from "@/aws";
import * as EC2 from "@/aws/ec2";
import type { Input } from "@/input";
import { $, apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";
import * as Output from "@/output";

const logLevel = Logger.withMinimumLogLevel(
  process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
);

test(
  "create, update, delete subnet",
  Effect.gen(function* () {
    const ec2 = yield* EC2.EC2Client;

    yield* destroy();

    {
      class TestVpc extends EC2.Vpc("TestVpc", {
        cidrBlock: "10.0.0.0/16",
      }) {}

      class TestSubnet extends EC2.Subnet("TestSubnet", {
        vpcId: Output.of(TestVpc).vpcId,
        cidrBlock: "10.0.1.0/24",
      }) {}

      const stack = yield* apply(TestVpc, TestSubnet);

      const actualSubnet = yield* ec2.describeSubnets({
        SubnetIds: [stack.TestSubnet.subnetId],
      });

      expect(actualSubnet.Subnets?.[0]?.SubnetId).toEqual(
        stack.TestSubnet.subnetId,
      );
      expect(actualSubnet.Subnets?.[0]?.CidrBlock).toEqual("10.0.1.0/24");
      expect(actualSubnet.Subnets?.[0]?.VpcId).toEqual(stack.TestVpc.vpcId);
      expect(actualSubnet.Subnets?.[0]?.State).toEqual("available");
      expect(actualSubnet.Subnets?.[0]?.MapPublicIpOnLaunch).toEqual(false);
    }

    // Update subnet attributes
    class TestVpc extends EC2.Vpc("TestVpc", {
      cidrBlock: "10.0.0.0/16",
    }) {}

    class TestSubnet extends EC2.Subnet("TestSubnet", {
      vpcId: Output.of(TestVpc).vpcId,
      cidrBlock: "10.0.1.0/24",
      mapPublicIpOnLaunch: true,
    }) {}

    const stack = yield* apply(TestVpc, TestSubnet);

    yield* expectSubnetAttribute({
      SubnetId: stack.TestSubnet.subnetId,
      Attribute: "mapPublicIpOnLaunch",
      Value: true,
    });

    // Delete subnet and VPC
    yield* destroy();

    yield* assertSubnetDeleted(stack.TestSubnet.subnetId);
  }).pipe(Effect.provide(AWS.live), logLevel),
);

const expectSubnetAttribute = Effect.fn(function* (props: {
  SubnetId: string;
  Attribute: "mapPublicIpOnLaunch" | "assignIpv6AddressOnCreation";
  Value: boolean;
}) {
  const ec2 = yield* EC2.EC2Client;
  yield* ec2
    .describeSubnets({
      SubnetIds: [props.SubnetId],
    })
    .pipe(
      Effect.tap(Effect.logDebug),
      Effect.flatMap((result) => {
        const subnet = result.Subnets?.[0];
        const actualValue =
          props.Attribute === "mapPublicIpOnLaunch"
            ? subnet?.MapPublicIpOnLaunch
            : subnet?.AssignIpv6AddressOnCreation;

        return actualValue === props.Value
          ? Effect.succeed(result)
          : Effect.fail(new SubnetAttributeStale());
      }),
      Effect.retry({
        while: (e) => e._tag === "SubnetAttributeStale",
        schedule: Schedule.exponential(100),
      }),
    );
});

const assertSubnetDeleted = Effect.fn(function* (subnetId: string) {
  const ec2 = yield* EC2.EC2Client;
  yield* ec2
    .describeSubnets({
      SubnetIds: [subnetId],
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new SubnetStillExists())),
      Effect.retry({
        while: (e) => e._tag === "SubnetStillExists",
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
    );
});

class SubnetStillExists extends Data.TaggedError("SubnetStillExists") {}

class SubnetAttributeStale extends Data.TaggedError("SubnetAttributeStale") {}
