import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { decodeTask, Task, TaskApi, TaskNotFound } from "./api.ts";

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

const corsLayer = HttpRouter.cors({
  allowedOrigins: ["*"],
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});

const Bucket = Cloudflare.R2Bucket("Tasks");

export default class HttpApiTestWorker extends Cloudflare.Worker<HttpApiTestWorker>()(
  "HttpApiTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const tasks = yield* Cloudflare.R2Bucket.bind(Bucket);

    const tasksGroup = HttpApiBuilder.group(TaskApi, "Tasks", (handlers) =>
      handlers
        .handle(
          "getTask",
          Effect.fn(function* ({ params }) {
            const task = yield* tasks.get(params.id).pipe(
              Effect.flatMap((data) =>
                data
                  ? data.text().pipe(Effect.map((data) => JSON.parse(data)))
                  : Effect.succeed(undefined),
              ),
              Effect.orDie,
            );
            if (!task) {
              return yield* Effect.fail(new TaskNotFound({ id: params.id }));
            }
            return decodeTask(task);
          }),
        )
        .handle(
          "createTask",
          Effect.fn(function* ({ payload }) {
            const task = new Task({
              id: crypto.randomUUID(),
              title: payload.title,
              completed: false,
            });
            yield* tasks.put(task.id, JSON.stringify(task)).pipe(Effect.orDie);
            return task;
          }),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(TaskApi).pipe(
        Layer.provide(tasksGroup),
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        Layer.provide(corsLayer),
        HttpRouter.toHttpEffect,
      ),
    };
  }).pipe(Effect.provide(Cloudflare.R2BucketBindingLive)),
) {}
