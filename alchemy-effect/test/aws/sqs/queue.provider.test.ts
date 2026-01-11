import * as AWS from "@/aws";
import { Queue } from "@/aws/sqs";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as SQS from "distilled-aws/sqs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

test(
  "create, update, delete standard queue",
  Effect.gen(function* () {
    class TestQueue extends Queue("TestQueue", {
      schema: S.Struct({
        message: S.String,
      }),
      visibilityTimeout: 30,
      delaySeconds: 0,
    }) {}

    const stack = yield* apply(TestQueue);

    // Verify the queue was created
    const queueAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: stack.TestQueue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(queueAttributes.Attributes?.VisibilityTimeout).toEqual("30");
    expect(queueAttributes.Attributes?.DelaySeconds).toEqual("0");

    // Update the queue
    class UpdatedQueue extends Queue("TestQueue", {
      schema: S.Struct({
        message: S.String,
      }),
      visibilityTimeout: 60,
      delaySeconds: 5,
    }) {}

    const updatedStack = yield* apply(UpdatedQueue);

    // Verify the queue was updated
    const updatedAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: updatedStack.TestQueue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(updatedAttributes.Attributes?.VisibilityTimeout).toEqual("60");
    expect(updatedAttributes.Attributes?.DelaySeconds).toEqual("5");

    yield* destroy();

    yield* assertQueueDeleted(stack.TestQueue.queueUrl);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create, update, delete fifo queue",
  Effect.gen(function* () {
    class TestFifoQueue extends Queue("TestFifoQueue", {
      schema: S.Struct({
        message: S.String,
      }),
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: 30,
    }) {}

    const stack = yield* apply(TestFifoQueue);

    // Verify the FIFO queue was created
    expect(stack.TestFifoQueue.queueUrl).toContain(".fifo");
    expect(stack.TestFifoQueue.queueName).toContain(".fifo");

    const queueAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: stack.TestFifoQueue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(queueAttributes.Attributes?.FifoQueue).toEqual("true");
    expect(queueAttributes.Attributes?.ContentBasedDeduplication).toEqual(
      "false",
    );

    // Update the FIFO queue to enable content-based deduplication
    class UpdatedFifoQueue extends Queue("TestFifoQueue", {
      schema: S.Struct({
        message: S.String,
      }),
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: 60,
    }) {}

    const updatedStack = yield* apply(UpdatedFifoQueue);

    // Verify the queue was updated
    const updatedAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: updatedStack.TestFifoQueue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(updatedAttributes.Attributes?.ContentBasedDeduplication).toEqual(
      "true",
    );
    expect(updatedAttributes.Attributes?.VisibilityTimeout).toEqual("60");

    yield* destroy();

    yield* assertQueueDeleted(stack.TestFifoQueue.queueUrl);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create queue with custom name",
  Effect.gen(function* () {
    class CustomNameQueue extends Queue("CustomNameQueue", {
      schema: S.Struct({
        data: S.Number,
      }),
      queueName: "my-custom-test-queue",
    }) {}

    const stack = yield* apply(CustomNameQueue);

    expect(stack.CustomNameQueue.queueName).toEqual("my-custom-test-queue");
    expect(stack.CustomNameQueue.queueUrl).toContain("my-custom-test-queue");

    // Verify the queue exists
    const queueAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: stack.CustomNameQueue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(queueAttributes.Attributes).toBeDefined();

    yield* destroy();

    yield* assertQueueDeleted(stack.CustomNameQueue.queueUrl);
  }).pipe(Effect.provide(AWS.providers())),
);

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

const assertQueueDeleted = Effect.fn(function* (queueUrl: string) {
  yield* SQS.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["All"],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new QueueStillExists())),
    Effect.retry({
      while: (e) => e._tag === "QueueStillExists",
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
  );
});
