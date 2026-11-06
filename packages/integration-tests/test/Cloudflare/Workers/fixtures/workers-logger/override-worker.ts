import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Telemetry from "alchemy/Telemetry";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Logger from "effect/Logger";
import { logEveryLevel, recordConsole } from "./record.ts";

/**
 * Effect-native Worker that registers its own logger through
 * `Telemetry.layer`: `/` logs at every level and answers with the console
 * calls those logs made.
 */
export default class WorkersLoggerOverrideWorker extends Cloudflare.Worker<WorkersLoggerOverrideWorker>()(
  "WorkersLoggerOverrideWorker",
  { main: import.meta.url },
  Effect.succeed({
    fetch: recordConsole(logEveryLevel).pipe(Effect.flatMap(HttpServerResponse.json)),
  }).pipe(
    Effect.provide(
      Telemetry.layer(
        Logger.layer([
          Logger.withConsoleLog(Logger.make(({ logLevel, message }) => [logLevel, message])),
        ]),
      ),
    ),
  ),
) {}
