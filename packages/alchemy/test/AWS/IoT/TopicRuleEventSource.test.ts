import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import IoTEventSourceFunctionLive, {
  IoTEventSourceFunction,
} from "./iot-event-source-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe.sequential("AWS.IoT.TopicRuleEventSource", () => {
  test.provider(
    "publishes via the Publish binding, routes through the topic rule, and observes delivery",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const fn = yield* stack.deploy(
          IoTEventSourceFunction.pipe(
            Effect.provide(IoTEventSourceFunctionLive),
          ),
        );
        const functionUrl = fn.functionUrl!.replace(/\/+$/, "");

        // Ride out cold-start / URL propagation until /ready reports the queue.
        const { resultQueueUrl } = yield* HttpClient.get(
          `${functionUrl}/ready`,
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? (response.json as Effect.Effect<{ resultQueueUrl?: string }>)
              : Effect.fail(new FunctionNotReady(`status ${response.status}`)),
          ),
          Effect.flatMap((body) =>
            body.resultQueueUrl
              ? Effect.succeed(body as { resultQueueUrl: string })
              : Effect.fail(new FunctionNotReady("no result queue")),
          ),
          Effect.retry({
            schedule: Schedule.fixed("1 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );

        // Publish a uniquely-marked message from inside the Lambda via the IoT
        // Publish binding. The topic rule matches it and re-invokes the Lambda,
        // whose event-source handler forwards it into the result queue.
        const marker = `iot-${crypto.randomUUID()}`;
        yield* HttpClient.execute(
          HttpClientRequest.post(`${functionUrl}/publish`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ marker }),
          ),
        ).pipe(
          Effect.filterOrFail(
            (response) => response.status === 200,
            (response) => new FunctionNotReady(`publish ${response.status}`),
          ),
          Effect.retry({
            while: (e) => e._tag === "FunctionNotReady",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(15)),
            ),
          }),
        );

        // Poll the result queue until the forwarded message (carrying the
        // marker) shows up. Bounded: ~45 polls, each a 2s long-poll — IoT rule
        // provisioning + permission propagation can take a while on a fresh
        // deploy, so republish periodically while we wait.
        const received = yield* Effect.gen(function* () {
          const result = yield* SQS.receiveMessage({
            QueueUrl: resultQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
          });
          const match = (result.Messages ?? []).find((message) =>
            message.Body?.includes(marker),
          );
          if (!match?.ReceiptHandle) {
            // Republish in case the earlier publish predated rule/permission
            // readiness.
            yield* HttpClient.execute(
              HttpClientRequest.post(`${functionUrl}/publish`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ marker }),
              ),
            ).pipe(Effect.ignore);
            return yield* Effect.fail(new MessageNotDelivered());
          }
          yield* SQS.deleteMessage({
            QueueUrl: resultQueueUrl,
            ReceiptHandle: match.ReceiptHandle,
          });
          return match.Body!;
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "MessageNotDelivered",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(45)),
            ),
          }),
        );

        expect(received).toContain(marker);

        yield* stack.destroy();
      }),
    { timeout: 300_000 },
  );
});

class MessageNotDelivered extends Data.TaggedError("MessageNotDelivered") {}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
