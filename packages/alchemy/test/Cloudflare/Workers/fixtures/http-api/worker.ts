import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Task, TaskApi, TaskNotFound } from "./api.ts";

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

export default class HttpApiTestWorker extends Cloudflare.Worker<HttpApiTestWorker>()(
  "HttpApiTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const tasks = new Map<string, Task>();

    const tasksGroup = HttpApiBuilder.group(TaskApi, "Tasks", (handlers) =>
      handlers
        .handle("getTask", ({ params }) => {
          const task = tasks.get(params.id);
          if (!task) {
            return Effect.fail(new TaskNotFound({ id: params.id }));
          }
          return Effect.succeed(task);
        })
        .handle("createTask", ({ payload }) =>
          Effect.sync(() => {
            const task = new Task({
              id: crypto.randomUUID(),
              title: payload.title,
              completed: false,
            });
            tasks.set(task.id, task);
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
  }),
) {}
