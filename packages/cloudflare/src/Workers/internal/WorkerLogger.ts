import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";
import * as Redacted from "effect/Redacted";
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References";

/**
 * The console method Workers Logs records each Effect log level under, so
 * `Effect.logError` is an error-level log: SQL custom alerts can filter on
 * `level = 'error'`, and Workers Issues sees it as a logged error.
 */
const consoleFor = (level: LogLevel.LogLevel): ((...args: ReadonlyArray<unknown>) => void) => {
  switch (level) {
    case "Fatal":
    case "Error":
      return console.error;
    case "Warn":
      return console.warn;
    case "Debug":
    case "Trace":
      return console.debug;
    default:
      return console.info;
  }
};

const render = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Never hand a secret to the console: Workers Logs stores the fields verbatim. */
const field = (value: unknown): unknown => (Redacted.isRedacted(value) ? "<redacted>" : value);

/**
 * Writes each Effect log entry as one console call under the method matching
 * its level, so Workers Logs records one event per entry at its real level.
 *
 * The message is the first argument, followed by the cause and any further
 * message parts. It carries no timestamp or fiber id: Workers Logs records
 * the time itself, and groups Workers Issues by message, so either would split
 * one recurring error into an issue per request.
 *
 * Log annotations, log spans and the name of the active Effect span go in a
 * second, structured argument. Workers Logs turns its keys into `attributes`,
 * so SQL custom alerts can filter on them, e.g. `attributes['orderId']` or
 * `attributes['spanName'] = 'checkout.charge'`.
 *
 * `Logger.consolePretty` writes every level through `console.log` and splits
 * an entry over several calls, which Workers Logs records as separate
 * `log`-level events.
 */
export const WorkerLogger = Logger.make<unknown, void>(
  ({ cause, date, fiber, logLevel, message }) => {
    const messages = Array.isArray(message) ? message : [message];
    const [first, ...rest] =
      typeof messages[0] === "string" ? [messages[0], ...messages.slice(1)] : ["", ...messages];

    const lines = [first];
    if (cause.reasons.length > 0) lines.push(Cause.pretty(cause));
    for (const value of rest) lines.push(render(value));

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fiber.getRef(CurrentLogAnnotations))) {
      fields[key] = field(value);
    }
    const now = date.getTime();
    for (const [label, start] of fiber.getRef(CurrentLogSpans)) {
      fields[label] = `${now - start}ms`;
    }
    const span = fiber.cache.span;
    if (span?._tag === "Span") fields.spanName = span.name;

    const log = consoleFor(logLevel);
    if (Object.keys(fields).length === 0) log(lines.join("\n"));
    else log(lines.join("\n"), fields);
  },
);
