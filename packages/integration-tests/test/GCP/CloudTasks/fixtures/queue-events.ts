import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** Queue the host works; retried tasks back off briefly. */
export const Work = GCP.CloudTasks.Queue("Work", {
  location: "us-central1",
  retryConfig: { maxAttempts: 5, minBackoff: "1s", maxBackoff: "5s" },
});

/** Bucket the worker records each dispatched task in. */
export const TaskMarkers = GCP.Storage.Bucket("TaskMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/** A task whose body is this fails on the first attempt the worker sees. */
export const FAIL_ONCE = "fail-once";

/**
 * Effect-native Cloud Run service working a Cloud Tasks queue, recording
 * each task as `<body>/<executionCount>.json`.
 * Deployed from {@link ../QueueEventSource.test.ts}.
 */
export default class QueueWorker extends GCP.Function<QueueWorker>()(
  "QueueWorker",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const markers = yield* TaskMarkers;
    const putObject = yield* GCP.Storage.PutObject(markers);

    // Dispatches rejected while IAM propagates also count as retries, so fail
    // the first attempt this instance sees rather than retry 0.
    const failed = new Set<string>();

    yield* GCP.CloudTasks.consumeQueueTasks(Work, (task) =>
      Effect.gen(function* () {
        const body = new TextDecoder().decode(task.body);
        yield* putObject({
          name: `${body}/${task.executionCount}.json`,
          body: JSON.stringify({ ...task, body, headers: undefined }),
        }).pipe(Effect.orDie);
        if (body === FAIL_ONCE && !failed.has(task.taskName)) {
          failed.add(task.taskName);
          return yield* Effect.die(new Error("first attempt fails"));
        }
      }),
    );

    // Anything the queue listener didn't claim is a misrouted dispatch: fail it,
    // so the task stays queued with the path it was sent to.
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return HttpServerResponse.text(`unclaimed ${request.method} ${request.url}`, {
          status: 404,
        });
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(GCP.Run.QueueEventSource, GCP.Storage.PutObjectHttp))),
) {}
