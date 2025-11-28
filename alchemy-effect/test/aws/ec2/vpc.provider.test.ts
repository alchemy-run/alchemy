import * as AWS from "@/aws";
import * as EC2 from "@/aws/ec2";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";
import * as ec2 from "itty-aws/ec2";

const logLevel = Logger.withMinimumLogLevel(
  process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
);

test(
  "create, update, delete vpc",
  Effect.gen(function* () {
    const ec2 = yield* EC2.EC2Client;

    {
      class TestVpc extends EC2.Vpc("TestVpc", {
        cidrBlock: "10.0.0.0/16",
        enableDnsSupport: true,
        enableDnsHostnames: true,
      }) {}

      const stack = yield* apply(TestVpc);

      const actualVpc = yield* ec2.describeVpcs({
        VpcIds: [stack.TestVpc.vpcId],
      });
      expect(actualVpc.Vpcs?.[0]?.VpcId).toEqual(stack.TestVpc.vpcId);
      expect(actualVpc.Vpcs?.[0]?.CidrBlock).toEqual("10.0.0.0/16");
      expect(actualVpc.Vpcs?.[0]?.State).toEqual("available");

      yield* expectVpcAttribute({
        VpcId: stack.TestVpc.vpcId,
        Attribute: "enableDnsSupport",
        Value: true,
      });

      yield* expectVpcAttribute({
        VpcId: stack.TestVpc.vpcId,
        Attribute: "enableDnsHostnames",
        Value: true,
      });
    }

    class TestVpc extends EC2.Vpc("TestVpc", {
      cidrBlock: "10.0.0.0/16",
      enableDnsSupport: false,
      enableDnsHostnames: false,
    }) {}

    const stack = yield* apply(TestVpc);

    yield* expectVpcAttribute({
      VpcId: stack.TestVpc.vpcId,
      Attribute: "enableDnsSupport",
      Value: false,
    });

    yield* expectVpcAttribute({
      VpcId: stack.TestVpc.vpcId,
      Attribute: "enableDnsHostnames",
      Value: false,
    });

    yield* destroy();

    yield* assertVpcDeleted(stack.TestVpc.vpcId);
  }).pipe(Effect.provide(AWS.live), logLevel),
);

const expectVpcAttribute = Effect.fn(function* (props: {
  VpcId: string;
  Attribute: ec2.VpcAttributeName;
  Value: boolean;
}) {
  const ec2 = yield* EC2.EC2Client;
  yield* ec2
    .describeVpcAttribute({
      VpcId: props.VpcId,
      Attribute: props.Attribute,
    })
    .pipe(
      Effect.tap(Effect.logDebug),
      Effect.flatMap((result: any) =>
        result[`${props.Attribute[0].toUpperCase()}${props.Attribute.slice(1)}`]
          ?.Value === props.Value
          ? Effect.succeed(result)
          : Effect.fail(new VpcAttributeStale()),
      ),
      Effect.retry({
        while: (e) => e._tag === "VpcAttributeStale",
        schedule: Schedule.exponential(100),
      }),
    );
});

class VpcAttributeStale extends Data.TaggedError("VpcAttributeStale") {}

class VpcStillExists extends Data.TaggedError("VpcStillExists") {}

export const assertVpcDeleted = Effect.fn(function* (vpcId: string) {
  const ec2 = yield* EC2.EC2Client;
  yield* ec2
    .describeVpcs({
      VpcIds: [vpcId],
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new VpcStillExists())),
      Effect.retry({
        while: (e) => e._tag === "VpcStillExists",
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
    );
});
