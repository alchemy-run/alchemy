import { cron, CronEventSourceLive } from "@alchemy.run/celld/CronEventSource";
import { consumeQueueMessages, EventSourceLive } from "@alchemy.run/celld/Queues/EventSource";
import type { Queue } from "@alchemy.run/celld/Queues/Queue";
import { WriteQueue } from "@alchemy.run/celld/Queues/WriteQueue";
import { WriteQueueBinding } from "@alchemy.run/celld/Queues/WriteQueueBinding";
import { Workflow } from "@alchemy.run/celld/Workflows/Workflow";
import { task } from "@alchemy.run/celld/Workflows/WorkflowRuntime";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/** Worker implementation for live Application tests; the caller supplies durable observation storage. */
export const runtimeEvents = (options: {
  queue: Queue;
  deadLetterQueue: Queue;
  observe: (key: string, value: unknown) => Effect.Effect<void, unknown, RuntimeContext>;
}) =>
  Effect.gen(function* () {
    const writer = yield* WriteQueue(options.queue);
    const reports = yield* Workflow(
      "RuntimeReports",
      Effect.succeed((input: { id: string }) =>
        task("record", options.observe(`workflow:${input.id}`, input).pipe(Effect.as(input))),
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
            yield* reports.createBatch([{ id: message.body.id, params: message.body }]);
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
  }).pipe(Effect.provide(Layer.mergeAll(WriteQueueBinding, EventSourceLive, CronEventSourceLive)));
