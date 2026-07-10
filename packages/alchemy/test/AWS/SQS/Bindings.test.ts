import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import SQSTestFunctionLive, { SQSTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SQSBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling so we don't fail the whole suite on a slow init.
const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

let baseUrl: string;
let queueUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load — a cold re-init or an eventually-consistent SQS
// call that the handler's `Effect.orDie` surfaces as a 500. Retry only 5xx;
// a genuine 4xx/assertion failure is returned immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(6)),
      ),
    }),
  );

const post = (route: string, body: unknown) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${route}`),
      body,
    ),
  ).pipe(Effect.flatMap((r) => r.json));

interface ReceivedMessage {
  messageId: string;
  body: string;
  receiptHandle: string;
}

class MessageNotReceived extends Data.TaggedError("MessageNotReceived") {}

// Poll the fixture's /receive route (the ReceiveMessage binding) until every
// body in `bodies` has been observed; returns a map body -> received message.
// Bounded: ~20 polls, each an SQS long-poll of 2s.
const receiveViaBindingUntil = (
  bodies: string[],
  options?: { visibilityTimeout?: number },
) =>
  Effect.gen(function* () {
    const found = new Map<string, ReceivedMessage>();
    yield* Effect.gen(function* () {
      const response = (yield* post("/receive", {
        maxNumberOfMessages: 10,
        waitTimeSeconds: 2,
        ...(options?.visibilityTimeout !== undefined
          ? { visibilityTimeout: options.visibilityTimeout }
          : {}),
      })) as unknown as { messages: ReceivedMessage[] };
      for (const message of response.messages) {
        if (bodies.includes(message.body)) {
          found.set(message.body, message);
        }
      }
      if (found.size < bodies.length) {
        return yield* Effect.fail(new MessageNotReceived());
      }
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "MessageNotReceived",
        schedule: Schedule.fixed("1 second").pipe(
          Schedule.both(Schedule.recurs(20)),
        ),
      }),
    );
    return found;
  });

// Out-of-band verification: poll the queue via distilled until every body in
// `bodies` has been received, deleting each matching message as it arrives.
const receiveAndDeleteViaDistilled = (bodies: string[]) =>
  Effect.gen(function* () {
    const found = new Set<string>();
    yield* Effect.gen(function* () {
      const result = yield* SQS.receiveMessage({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      });
      for (const message of result.Messages ?? []) {
        if (
          message.Body &&
          message.ReceiptHandle &&
          bodies.includes(message.Body)
        ) {
          found.add(message.Body);
          yield* SQS.deleteMessage({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          });
        }
      }
      if (found.size < bodies.length) {
        return yield* Effect.fail(new MessageNotReceived());
      }
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "MessageNotReceived",
        schedule: Schedule.fixed("1 second").pipe(
          Schedule.both(Schedule.recurs(20)),
        ),
      }),
    );
  });

// All five tests share ONE queue; a concurrent receive in test A steals (and
// hides, for the visibility timeout) messages test B is polling for. The
// global vitest `sequence: { concurrent: true }` must not apply here.
describe.sequential("SQS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SQS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SQS test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SQSTestFunction;
        }).pipe(Effect.provide(SQSTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `SQS test setup: probing readiness at ${baseUrl}/ready`,
      );

      // A freshly-deployed function can briefly serve a 200 before its
      // captured env vars (the queue URL) finish propagating; keep polling
      // until the queue URL is populated.
      const ready = yield* HttpClient.get(`${baseUrl}/ready`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? (response.json as Effect.Effect<{ queueUrl?: string }>)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body) =>
          typeof body?.queueUrl === "string" && body.queueUrl.length > 0
            ? Effect.succeed(body as { queueUrl: string })
            : Effect.fail(new Error("Function returned empty queue URL")),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SQS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      queueUrl = ready.queueUrl;

      yield* Effect.logInfo(
        `SQS test setup: fixture ready (queueUrl: ${queueUrl})`,
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 60_000 });

  describe("SendMessage", () => {
    test.provider("sends a message through the bound queue", (_stack) =>
      Effect.gen(function* () {
        const messageBody = `send-${crypto.randomUUID()}`;

        const response = (yield* post("/send", { messageBody })) as {
          messageId?: string;
        };
        expect(response.messageId).toBeTruthy();

        // Out-of-band: the message is actually in the queue.
        yield* receiveAndDeleteViaDistilled([messageBody]);
      }),
    );
  });

  describe("SendMessageBatch", () => {
    test.provider(
      "sends a batch of messages through the bound queue",
      (_stack) =>
        Effect.gen(function* () {
          const bodies = [
            `batch-${crypto.randomUUID()}`,
            `batch-${crypto.randomUUID()}`,
            `batch-${crypto.randomUUID()}`,
          ];

          const response = (yield* post("/send-batch", {
            entries: bodies.map((messageBody, index) => ({
              id: `entry-${index}`,
              messageBody,
            })),
          })) as {
            successful: { id: string; messageId: string }[];
            failed: { id: string; code: string }[];
          };

          expect(response.failed).toHaveLength(0);
          expect(response.successful).toHaveLength(3);
          for (const entry of response.successful) {
            expect(entry.messageId).toBeTruthy();
          }

          // Out-of-band: all three messages landed in the queue.
          yield* receiveAndDeleteViaDistilled(bodies);
        }),
    );
  });

  describe("ReceiveMessage", () => {
    test.provider("receives a message through the bound queue", (_stack) =>
      Effect.gen(function* () {
        const messageBody = `receive-${crypto.randomUUID()}`;

        // Out-of-band send via distilled; receive via the binding.
        yield* SQS.sendMessage({
          QueueUrl: queueUrl,
          MessageBody: messageBody,
        });

        const found = yield* receiveViaBindingUntil([messageBody]);
        const message = found.get(messageBody)!;
        expect(message.messageId).toBeTruthy();
        expect(message.receiptHandle).toBeTruthy();

        // Cleanup: delete with the receipt handle the binding returned.
        yield* SQS.deleteMessage({
          QueueUrl: queueUrl,
          ReceiptHandle: message.receiptHandle,
        });
      }),
    );
  });

  describe("DeleteMessage", () => {
    test.provider(
      "deletes a received message through the bound queue",
      (_stack) =>
        Effect.gen(function* () {
          const messageBody = `delete-${crypto.randomUUID()}`;

          yield* SQS.sendMessage({
            QueueUrl: queueUrl,
            MessageBody: messageBody,
          });

          // Receive with a short (5s) visibility timeout: long enough that the
          // receipt handle is still the freshest when /delete runs, short
          // enough that an undeleted message reappears within the absence poll.
          const found = yield* receiveViaBindingUntil([messageBody], {
            visibilityTimeout: 5,
          });
          const message = found.get(messageBody)!;

          const response = (yield* post("/delete", {
            receiptHandle: message.receiptHandle,
          })) as { success: boolean };
          expect(response.success).toBe(true);

          // The deleted message must not reappear after its 1s visibility
          // timeout lapses. Bounded absence poll (~10s of 1s long-polls).
          yield* Effect.gen(function* () {
            const result = yield* SQS.receiveMessage({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
              VisibilityTimeout: 1,
            });
            const bodies = (result.Messages ?? []).map((m) => m.Body);
            expect(bodies).not.toContain(messageBody);
          }).pipe(
            Effect.repeat({
              schedule: Schedule.fixed("1 second").pipe(
                Schedule.both(Schedule.recurs(5)),
              ),
            }),
          );
        }),
    );
  });

  describe("DeleteMessageBatch", () => {
    test.provider(
      "deletes a batch of received messages through the bound queue",
      (_stack) =>
        Effect.gen(function* () {
          const bodies = [
            `delete-batch-${crypto.randomUUID()}`,
            `delete-batch-${crypto.randomUUID()}`,
          ];

          yield* SQS.sendMessageBatch({
            QueueUrl: queueUrl,
            Entries: bodies.map((body, index) => ({
              Id: `entry-${index}`,
              MessageBody: body,
            })),
          });

          // 15s visibility: long enough that both receipt handles stay valid
          // while we collect the pair across polls, short enough that a message
          // consumed by a failed invocation resurfaces within the poll budget.
          const found = yield* receiveViaBindingUntil(bodies, {
            visibilityTimeout: 15,
          });

          const response = (yield* post("/delete-batch", {
            entries: bodies.map((body, index) => ({
              id: `entry-${index}`,
              receiptHandle: found.get(body)!.receiptHandle,
            })),
          })) as {
            successful: string[];
            failed: { id: string; code: string }[];
          };

          expect(response.failed).toHaveLength(0);
          expect(response.successful.sort()).toEqual(["entry-0", "entry-1"]);
        }),
    );
  });
});
