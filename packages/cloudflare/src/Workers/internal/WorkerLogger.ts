import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";
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

/**
 * Writes each Effect log entry as one console call under the method matching
 * its level. The first line is the message alone: Workers Logs records the
 * time and level itself, and groups Workers Issues by message, so a timestamp
 * or fiber id there would split one recurring error into an issue per request.
 * Spans, the cause, further message parts and annotations follow on later
 * lines.
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
    const now = date.getTime();
    const spans = fiber.getRef(CurrentLogSpans);
    if (spans.length > 0) {
      lines.push(spans.map(([label, start]) => `${label}=${now - start}ms`).join(" "));
    }
    if (cause.reasons.length > 0) lines.push(Cause.pretty(cause));
    for (const value of rest) lines.push(render(value));
    for (const [key, value] of Object.entries(fiber.getRef(CurrentLogAnnotations))) {
      lines.push(`${key}: ${render(value)}`);
    }

    consoleFor(logLevel)(lines.join("\n"));
  },
);
