import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kinesis from "@distilled.cloud/aws/kinesis";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:kinesis", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "StreamLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stream = yield* AWS.Kinesis.Stream("lookup-target", {
      streamMode: "PROVISIONED",
      shardCount: 1,
    });
    return {
      streamName: stream.streamName.as<string>(),
      streamArn: stream.streamArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up stream resolves by name and by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { streamName, streamArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.Kinesis.Stream.lookup({ streamName });
          const byArn = AWS.Kinesis.Stream.lookup({ streamArn });
          return { arn: byName.streamArn, name: byArn.streamName };
        },
        {
          arn: streamArn,
          name: streamName,
        },
      );
      const survivor = yield* kinesis.describeStreamSummary({ StreamName: streamName });
      expect(survivor.StreamDescriptionSummary?.StreamARN).toBe(streamArn);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing stream fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-stream", {
            value: AWS.Kinesis.Stream.lookup({ streamName: name }).streamArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a stream this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.Kinesis.Stream("lookup-managed", { streamMode: "PROVISIONED", shardCount: 1 });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-stream-consumer", {
              value: AWS.Kinesis.Stream.lookup({ streamName: attrs.streamName }).streamArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);
