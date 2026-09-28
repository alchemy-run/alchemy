import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { cron, CronEventSourceLive } from "@/Celld/CronEventSource.ts";
import {
  consumeQueueMessages,
  EventSourceLive,
} from "@/Celld/Queues/EventSource.ts";
import type { Queue } from "@/Celld/Queues/Queue.ts";
import { WriteQueue } from "@/Celld/Queues/WriteQueue.ts";
import { WriteQueueBinding } from "@/Celld/Queues/WriteQueueBinding.ts";
import { Workflow } from "@/Celld/Workflows/Workflow.ts";
import { task } from "@/Celld/Workflows/WorkflowRuntime.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";

/** Worker implementation for live Application tests; the caller supplies durable observation storage. */
export const runtimeEvents = (options: {
  queue: Queue;
  deadLetterQueue: Queue;
  observe: (
    key: string,
    value: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
}) =>
  Effect.gen(function* () {
    const writer = yield* WriteQueue(options.queue);
    const reports = yield* Workflow(
      "RuntimeReports",
      Effect.succeed((input: { id: string }) =>
        task(
          "record",
          options.observe(`workflow:${input.id}`, input).pipe(Effect.as(input)),
        ),
      ),
    );
    yield* consumeQueueMessages<{ id: string }>(
      options.queue,
      {
        batchSize: 1,
        maxRetries: 2,
        retryDelay: "1 second",
        deadLetterQueue: options.deadLetterQueue,
      },
      (messages) =>
        Stream.runForEach(messages, (message) =>
          Effect.gen(function* () {
            yield* options.observe(`queue:${message.body.id}`, {
              attempts: message.attempts,
              messageId: message.id,
            });
            yield* reports.createBatch([
              { id: message.body.id, params: message.body },
            ]);
          }),
        ),
    );
    yield* cron("* * * * *", (event) =>
      options.observe("cron:last", {
        cron: event.cron,
        scheduledTime: event.scheduledTime,
      }),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = request.url.split("?")[0].split("/");
        const id = path[2] ?? "test";
        if (path[1] === "enqueue") {
          yield* writer.send({ id });
          return HttpServerResponse.text("queued", { status: 202 });
        }
        if (path[1] === "start") {
          const instance = yield* reports.create({ id, params: { id } });
          return yield* HttpServerResponse.json({ id: instance.id });
        }
        if (path[1] === "status") {
          const instance = yield* reports.get(id);
          return yield* HttpServerResponse.json(yield* instance.status());
        }
        if (path[1] === "delete") {
          const instance = yield* reports.get(id);
          yield* instance.delete();
          return HttpServerResponse.text("deleted");
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(WriteQueueBinding, EventSourceLive, CronEventSourceLive),
    ),
  );
