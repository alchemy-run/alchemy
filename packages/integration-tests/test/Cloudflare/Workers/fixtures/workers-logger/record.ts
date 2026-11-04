import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

/** A console call: the method and its arguments. */
export interface ConsoleCall {
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

/** Run `effect` with a console that records its calls instead of printing them. */
export const recordConsole = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const calls: Array<ConsoleCall> = [];
    const record =
      (method: string) =>
      (...args: ReadonlyArray<unknown>): void => {
        calls.push({ method, args });
      };
    const console: Console.Console = {
      ...globalThis.console,
      log: record("log"),
      error: record("error"),
      warn: record("warn"),
      info: record("info"),
      debug: record("debug"),
      trace: record("trace"),
    };
    yield* effect.pipe(Effect.provideService(Console.Console, console));
    return calls;
  });

/** One line at every level, annotated and inside a span. */
export const logEveryLevel = Effect.gen(function* () {
  yield* Effect.logFatal("fatal");
  yield* Effect.logError("error");
  yield* Effect.logWarning("warning");
  yield* Effect.logInfo("info");
  yield* Effect.logDebug("debug");
  yield* Effect.logTrace("trace");
}).pipe(
  Effect.annotateLogs({ reason: "card_declined", message: "not the message" }),
  Effect.withSpan("checkout.charge"),
  Effect.provideService(MinimumLogLevel, "All"),
);
