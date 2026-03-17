import * as AWS from "@/AWS";
import { Queue } from "@/AWS/SQS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { QueueSinkFixture } from "./sink-handler";

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

test(
  "QueueSink writes arbitrary messages through a deployed Lambda",
  { timeout: 180_000 },
  Effect.gen(function* () {
    // yield* destroy();

    const { queue, apiFunction } = yield* test.deploy(QueueSinkFixture);
    const baseUrl = apiFunction.functionUrl!.replace(/\/+$/, "");

    yield* waitForFunctionReady(`${baseUrl}/ready`);

    const messages = [
      `sink-${crypto.randomUUID()}`,
      `sink-${crypto.randomUUID()}`,
      `sink-${crypto.randomUUID()}`,
    ];
    const response = yield* HttpClient.post(`${baseUrl}/sink`, {
      body: yield* HttpBody.json({ messages }),
    }).pipe(
      Effect.flatMap((result) =>
        result.status === 200
          ? Effect.succeed(result)
          : Effect.fail("not ready"),
      ),
      Effect.tapError(Console.log),
      Effect.retry({
        while: (error) => error === "not ready",
        schedule: Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(9)),
        ),
      }),
      Effect.flatMap((result) => result.json),
    );

    expect((response as any).ok).toBe(true);
    expect((response as any).count).toBe(messages.length);

    const received = yield* waitForQueueMessages(
      queue.queueUrl,
      messages.length,
    );

    expect(received.sort()).toEqual([...messages].sort());

    yield* destroy();

    yield* assertQueueDeleted(queue.queueUrl);
  }).pipe(Effect.provide(AWS.providers())),
);

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady") {}

class QueueMessageNotReady extends Data.TaggedError("QueueMessageNotReady") {}

const waitForFunctionReady = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(new FunctionNotReady()),
    ),
    Effect.retry({
      while: (error) => error._tag === "FunctionNotReady",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(9)),
      ),
    }),
  );

const waitForQueueMessages = Effect.fn(function* (
  queueUrl: string,
  count: number,
) {
  const messages: string[] = [];

  while (messages.length < count) {
    messages.push(yield* waitForQueueMessage(queueUrl));
  }

  return messages;
});

const waitForQueueMessage = (queueUrl: string) =>
  Effect.gen(function* () {
    const result = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
      VisibilityTimeout: 5,
    });

    const message = result.Messages?.[0];
    if (!message?.Body || !message.ReceiptHandle) {
      return yield* Effect.fail(new QueueMessageNotReady());
    }

    const body = message.Body;

    yield* SQS.deleteMessage({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    });

    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "QueueMessageNotReady",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );

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
