import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Puller, registryFor } from "./registry.ts";
import { Tasks } from "./resources.ts";
import { Task, TaskApi, TaskNotFound } from "./TaskApi.ts";

const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(Task));

/**
 * An Effect `HttpApi` on a STACKIT Function. The schema in `TaskApi.ts` validates
 * requests and responses, and sends `TaskNotFound` as a 404.
 *
 * The bucket holds the tasks, one object per task, through
 * `Stackit.ObjectStorage.ReadWriteBucket`.
 */
export default class Api extends Stackit.Functions.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    const puller = yield* Puller;
    const registry = yield* registryFor("api");
    return {
      main: import.meta.url,
      registry,
      pullCredential: puller.pullCredentialId,
    };
  }),
  Effect.gen(function* () {
    const tasks = yield* Stackit.ObjectStorage.ReadWriteBucket(yield* Tasks);

    const group = HttpApiBuilder.group(TaskApi, "Tasks", (handlers) =>
      handlers
        .handle("getTask", ({ params }) =>
          Effect.gen(function* () {
            const object = yield* tasks.getObject({ Key: `tasks/${params.id}.json` }).pipe(
              Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
              Effect.orDie,
            );
            if (object === undefined) {
              return yield* new TaskNotFound({ id: params.id });
            }
            return yield* Stream.mkString(Stream.decodeText(object.Body!)).pipe(
              Effect.flatMap(decodeTask),
              Effect.orDie,
            );
          }),
        )
        .handle("createTask", ({ payload }) =>
          Effect.gen(function* () {
            const task = new Task({ id: crypto.randomUUID(), title: payload.title });
            yield* tasks.putObject({
              Key: `tasks/${task.id}.json`,
              Body: JSON.stringify(task),
            });
            return task;
          }).pipe(Effect.orDie),
        ),
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(TaskApi).pipe(Layer.provide(group)),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Stackit.ObjectStorage.ReadWriteBucketHttp, HttpPlatform.layer, Etag.layer),
    ),
  ),
) {}
