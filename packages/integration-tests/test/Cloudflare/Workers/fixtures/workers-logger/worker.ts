import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { logEveryLevel, recordConsole } from "./record.ts";

/** Logs at every level from a Durable Object call. */
export class WorkersLoggerObject extends Cloudflare.DurableObject<WorkersLoggerObject>()(
  "WorkersLoggerObject",
  Effect.succeed(
    Effect.succeed({
      log: () => recordConsole(logEveryLevel),
    }),
  ),
) {}

/**
 * Effect-native Worker on the bridge's default logger: `/` logs at every
 * level from the Worker's own fetch event, `/durable-object` from a Durable
 * Object call, and each answers with the console calls those logs made.
 */
export default class WorkersLoggerWorker extends Cloudflare.Worker<WorkersLoggerWorker>()(
  "WorkersLoggerWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* WorkersLoggerObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const calls = request.url.startsWith("/durable-object")
          ? yield* objects.getByName("logger").log()
          : yield* recordConsole(logEveryLevel);
        return yield* HttpServerResponse.json(calls);
      }),
    };
  }),
) {}
