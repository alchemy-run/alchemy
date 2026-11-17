import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sqs from "@distilled.cloud/aws/sqs";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:sqs", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "QueueLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const queue = yield* AWS.SQS.Queue("lookup-target");
    return {
      queueName: queue.queueName.as<string>(),
      queueUrl: queue.queueUrl.as<string>(),
      queueArn: queue.queueArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up queue resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { queueName, queueUrl, queueArn } = yield* target;

      yield* expectLookupConsumers(
        stack,
        () => {
          const queue = AWS.SQS.Queue.lookup({ queueName });
          return { url: queue.queueUrl, arn: queue.queueArn };
        },
        { url: queueUrl, arn: queueArn },
      );

      const survivor = yield* sqs.getQueueUrl({ QueueName: queueName });
      expect(survivor.QueueUrl).toBe(queueUrl);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing queue fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const queueName = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-queue", {
            value: AWS.SQS.Queue.lookup({ queueName }).queueArn,
          }),
        ),
        ["LookupNotFoundError", queueName],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a queue this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.SQS.Queue("lookup-managed");
      const { queueName } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-queue-consumer", {
              value: AWS.SQS.Queue.lookup({ queueName }).queueArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
