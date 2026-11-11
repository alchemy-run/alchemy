import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as firehose from "@distilled.cloud/aws/firehose";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:firehose", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "DeliveryStreamLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("lookup-target-bucket", { forceDestroy: true });
    const stream = yield* AWS.Firehose.DeliveryStream("lookup-target", {
      destination: { bucketArn: bucket.bucketArn },
    });
    return {
      deliveryStreamName: stream.deliveryStreamName.as<string>(),
      deliveryStreamArn: stream.deliveryStreamArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up delivery stream resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { deliveryStreamName, deliveryStreamArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const stream = AWS.Firehose.DeliveryStream.lookup({ deliveryStreamName });
          return { arn: stream.deliveryStreamArn };
        },
        {
          arn: deliveryStreamArn,
        },
      );
      const survivor = yield* firehose.describeDeliveryStream({
        DeliveryStreamName: deliveryStreamName,
      });
      expect(survivor.DeliveryStreamDescription?.DeliveryStreamARN).toBe(deliveryStreamArn);
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a lookup of a missing delivery stream fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-delivery-stream", {
            value: AWS.Firehose.DeliveryStream.lookup({ deliveryStreamName: name })
              .deliveryStreamArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a lookup of a delivery stream this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("lookup-managed-bucket", { forceDestroy: true });
          return yield* AWS.Firehose.DeliveryStream("lookup-managed", {
            destination: { bucketArn: bucket.bucketArn },
          });
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-delivery-stream-consumer", {
              value: AWS.Firehose.DeliveryStream.lookup({
                deliveryStreamName: attrs.deliveryStreamName,
              }).deliveryStreamArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 300_000 },
);
