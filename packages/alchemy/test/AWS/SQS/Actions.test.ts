// Regression suite for Actions whose bodies call AWS SDK operations against
// an SQS Queue — see test/AWS/S3/Actions.test.ts for the full background.
// Action bodies run in the `Plan.make` -> `apply` phase under the compiled
// stack's services; under `ALCHEMY_TEST_DEV=1` (the floci local suite,
// `scripts/test-aws-floci.ts`) the harness pins the runners to the emulator
// (`pinStackActionsToFloci` in Test/Core.ts) so the Action hits the same
// environment the Queue was provisioned in. The same file runs live too.
import { Action } from "@/Action.ts";
import * as AWS from "@/AWS";
import { Queue } from "@/AWS/SQS";
import * as Test from "@/Test/Alchemy";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class QueueMessageNotReady extends Data.TaggedError("QueueMessageNotReady") {}

// Send a message and receive it back inside ONE Action body — both calls
// must resolve the same environment the Queue resource was reconciled in.
const RoundTrip = Action(
  "QueueRoundTrip",
  Effect.fn(function* (input: { queueUrl: string; body: string }) {
    yield* SQS.sendMessage({
      QueueUrl: input.queueUrl,
      MessageBody: input.body,
    });
    const received = yield* Effect.gen(function* () {
      const result = yield* SQS.receiveMessage({
        QueueUrl: input.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 5,
      });
      const message = result.Messages?.[0];
      if (!message?.Body || !message.ReceiptHandle) {
        return yield* Effect.fail(new QueueMessageNotReady());
      }
      yield* SQS.deleteMessage({
        QueueUrl: input.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      });
      return message.Body;
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "QueueMessageNotReady",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(20),
        ]),
      }),
    );
    return { received };
  }),
);

test.provider(
  "action SQS calls target the same environment as the queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Queue("ActionRoundTripQueue", {});
          const roundTrip = yield* RoundTrip({
            queueUrl: queue.queueUrl,
            body: "hello from an alchemy action",
          });
          return { queueUrl: queue.queueUrl, roundTrip };
        }),
      );

      expect(output.roundTrip.received).toBe("hello from an alchemy action");

      // The queue must also be visible to the test body's SQS client —
      // pinned to the same environment (emulator under ALCHEMY_TEST_DEV,
      // live cloud otherwise) as the queue and the Action.
      const attributes = yield* SQS.getQueueAttributes({
        QueueUrl: output.queueUrl,
        AttributeNames: ["QueueArn"],
      });
      expect(attributes.Attributes?.QueueArn).toBeDefined();

      yield* stack.destroy();
      yield* assertQueueDeleted(output.queueUrl);
    }),
  { timeout: 240_000 },
);

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

const assertQueueDeleted = Effect.fn(function* (queueUrl: string) {
  yield* SQS.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["All"],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new QueueStillExists())),
    Effect.retry({
      // SQS DeleteQueue propagation can run long under parallel load — poll
      // on a fixed cadence with a bounded budget (see Queue.test.ts).
      while: (e) => e._tag === "QueueStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(45),
      ]),
    }),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
    Effect.catch(() => Effect.void),
  );
});
