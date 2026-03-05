import * as AWS from "@/AWS";
import { Queue } from "@/AWS/SQS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as SQS from "distilled-aws/sqs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

test(
  "create and delete queue with default props",
  Effect.gen(function* () {
    const queue = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Queue("DefaultQueue");
      }),
    );

    expect(queue.queueName).toBeDefined();
    expect(queue.queueUrl).toBeDefined();
    expect(queue.queueArn).toBeDefined();

    const queueAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: queue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(queueAttributes.Attributes).toBeDefined();

    yield* destroy();

    yield* assertQueueDeleted(queue.queueUrl);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create, update, delete standard queue",
  Effect.gen(function* () {
    const queue = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Queue("TestQueue", {
          visibilityTimeout: 30,
          delaySeconds: 0,
        });
      }),
    );

    // Verify the queue was created
    const queueAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: queue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(queueAttributes.Attributes?.VisibilityTimeout).toEqual("30");
    expect(queueAttributes.Attributes?.DelaySeconds).toEqual("0");

    // Update the queue
    const updatedQueue = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Queue("TestQueue", {
          visibilityTimeout: 60,
          delaySeconds: 5,
        });
      }),
    );

    // Verify the queue was updated
    const updatedAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: updatedQueue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(updatedAttributes.Attributes?.VisibilityTimeout).toEqual("60");
    expect(updatedAttributes.Attributes?.DelaySeconds).toEqual("5");

    yield* destroy();

    yield* assertQueueDeleted(queue.queueUrl);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create, update, delete fifo queue",
  Effect.gen(function* () {
    const queue = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Queue("TestFifoQueue", {
          fifo: true,
          contentBasedDeduplication: false,
          visibilityTimeout: 30,
        });
      }),
    );

    // Verify the FIFO queue was created
    expect(queue.queueUrl).toContain(".fifo");
    expect(queue.queueName).toContain(".fifo");

    const queueAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: queue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(queueAttributes.Attributes?.FifoQueue).toEqual("true");
    expect(queueAttributes.Attributes?.ContentBasedDeduplication).toEqual(
      "false",
    );

    // Update the FIFO queue to enable content-based deduplication
    const updatedQueue = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Queue("TestFifoQueue", {
          fifo: true,
          contentBasedDeduplication: true,
          visibilityTimeout: 60,
        });
      }),
    );

    // Verify the queue was updated
    const updatedAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: updatedQueue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(updatedAttributes.Attributes?.ContentBasedDeduplication).toEqual(
      "true",
    );
    expect(updatedAttributes.Attributes?.VisibilityTimeout).toEqual("60");

    yield* destroy();

    yield* assertQueueDeleted(queue.queueUrl);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create queue with custom name",
  Effect.gen(function* () {
    const queue = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Queue("CustomNameQueue", {
          queueName: "my-custom-test-queue",
        });
      }),
    );

    expect(queue.queueName).toEqual("my-custom-test-queue");
    expect(queue.queueUrl).toContain("my-custom-test-queue");

    // Verify the queue exists
    const queueAttributes = yield* SQS.getQueueAttributes({
      QueueUrl: queue.queueUrl,
      AttributeNames: ["All"],
    });
    expect(queueAttributes.Attributes).toBeDefined();

    yield* destroy();

    yield* assertQueueDeleted(queue.queueUrl);
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
