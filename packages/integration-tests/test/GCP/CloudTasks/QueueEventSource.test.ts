import * as GCP from "@alchemy.run/gcp";
import { makeObjectMedia } from "@alchemy.run/gcp/Storage/ObjectMedia";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import QueueWorker, { FAIL_ONCE, TaskMarkers, Work } from "./fixtures/queue-events.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "a queue's tasks are dispatched to an effect-native Function, and failures retried",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* QueueWorker;
          return {
            uri: worker.uri,
            queue: (yield* Work).name,
            bucket: (yield* TaskMarkers).bucketName,
          };
        }),
      );

      // The event source bound a queue-level target to the worker.
      const queue = yield* cloudtasks.getProjectsLocationsQueues({ name: out.queue });
      expect(queue.httpTarget?.uriOverride?.host).toEqual(new URL(out.uri!).host);
      expect(queue.httpTarget?.uriOverride?.pathOverride?.path).toEqual(
        "/__alchemy/cloudtasks/work",
      );

      // Out of band: tasks addressed anywhere; the queue routes them to the worker.
      const run = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
      const ok = `ok-${run}`;
      const failOnce = FAIL_ONCE;
      for (const body of [ok, failOnce]) {
        yield* cloudtasks.createProjectsLocationsQueuesTasks({
          parent: out.queue,
          body: {
            task: {
              httpRequest: { url: "https://example.com/ignored", body: btoa(body) },
            },
          },
        });
      }

      // Markers for one task body, once at least `count` attempts reached the worker.
      // Until the worker's invoker grant propagates, dispatches are rejected
      // and Cloud Tasks retries them under the queue's retry config.
      const attempts = (body: string, count: number) =>
        storage.listObjects({ bucket: out.bucket, prefix: `${body}/` }).pipe(
          Effect.map((list) => list.items ?? []),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (items) => items.length >= count,
            times: 48,
          }),
        );

      const media = yield* makeObjectMedia;
      const [done] = yield* attempts(ok, 1);
      if (done === undefined) {
        // Say why: each task's last dispatch status.
        const { tasks = [] } = yield* cloudtasks.listProjectsLocationsQueuesTasks({
          parent: out.queue,
          responseView: "FULL",
        });
        return yield* Effect.die(
          new Error(
            `no task reached the worker: ${JSON.stringify(
              tasks.map((task) => ({
                dispatchCount: task.dispatchCount,
                lastAttempt: task.lastAttempt,
              })),
            )}`,
          ),
        );
      }
      const object = yield* media.download({ bucket: out.bucket, object: done!.name! });
      expect(JSON.parse(new TextDecoder().decode(object.body))).toMatchObject({
        body: ok,
        queueName: out.queue.split("/").at(-1),
      });

      // The first attempt the worker sees fails; Cloud Tasks retries it.
      expect((yield* attempts(failOnce, 2)).length).toBeGreaterThanOrEqual(2);

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
