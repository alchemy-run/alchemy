import * as Console from "effect/Console";
import * as Logger from "effect/Logger";
import * as Record from "effect/Record";

/**
 * The logger the Worker, Durable Object and Workflow bridges install for
 * every event.
 *
 * Workers Logs takes a line's level from the `console` method that wrote it,
 * and indexes the fields of a logged object. So each Effect log level goes
 * through its own method (`Error` and `Fatal` through `console.error`,
 * `Warn` through `console.warn`, `Info` through `console.info`, `Debug`
 * and `Trace` through `console.debug`), as one object:
 *
 * ```json
 * { "message": "payment declined", "reason": "card_declined", "spanName": "checkout.charge" }
 * ```
 *
 * Log annotations are top-level fields beside `message`, the current span's
 * name is `spanName`, `Effect.withLogSpan` durations are `spans`, and a
 * logged cause is `cause`. An annotation never replaces one of those fields.
 * There is no fiber id or timestamp, so every occurrence of an error logs the
 * same message.
 *
 * Replace it for a Worker's events with `Telemetry.layer`:
 *
 * ```typescript
 * Effect.provide(Telemetry.layer(Logger.layer([Logger.consolePretty()])))
 * ```
 */
export const workersLogger: Logger.Logger<unknown, void> = Logger.make((options) => {
  const { message, cause, annotations, spans } = Logger.formatStructured.log(options);
  const span = options.fiber.cache.span;
  const line = {
    message,
    ...Record.remove(annotations, "message"),
    ...(span?._tag === "Span" ? { spanName: span.name } : {}),
    ...(Record.isEmptyRecord(spans) ? {} : { spans }),
    ...(cause === undefined ? {} : { cause }),
  };
  const console = options.fiber.getRef(Console.Console);
  switch (options.logLevel) {
    case "Fatal":
    case "Error":
      return console.error(line);
    case "Warn":
      return console.warn(line);
    case "Info":
      return console.info(line);
    // Not `console.trace`, which prints a stack trace.
    case "Debug":
    case "Trace":
      return console.debug(line);
    default:
      return console.log(line);
  }
});
