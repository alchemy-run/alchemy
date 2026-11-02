import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Puller, registryFor } from "./registry.ts";
import { Tasks } from "./resources.ts";
import { Task, TaskNotFound, TaskRpcs } from "./TaskRpcs.ts";

const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(Task));

/**
 * An Effect RPC server on a STACKIT Function. The group in `TaskRpcs.ts` validates
 * payloads and results, and the client receives `TaskNotFound` as a typed error.
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

    const handlers = TaskRpcs.toLayer({
      getTask: ({ id }) =>
        Effect.gen(function* () {
          const object = yield* tasks.getObject({ Key: `tasks/${id}.json` }).pipe(
            Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
            Effect.orDie,
          );
          if (object === undefined) {
            return yield* Effect.fail(new TaskNotFound({ id }));
          }
          return yield* Stream.mkString(Stream.decodeText(object.Body!)).pipe(
            Effect.flatMap(decodeTask),
            Effect.orDie,
          );
        }),
      createTask: ({ title }) =>
        Effect.gen(function* () {
          const task = new Task({ id: crypto.randomUUID(), title });
          yield* tasks.putObject({
            Key: `tasks/${task.id}.json`,
            Body: JSON.stringify(task),
          });
          return task;
        }).pipe(Effect.orDie),
    });

    return { fetch: Stackit.Functions.ServeRpc(TaskRpcs, handlers) };
  }).pipe(Effect.provide(Stackit.ObjectStorage.ReadWriteBucketHttp)),
) {}
