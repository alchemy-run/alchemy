import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Eval } from "./Eval.ts";

/** Strip TypeScript annotations when running under bun; else run as-is. */
const transpile = (code: string): string => {
  const bun = (globalThis as any).Bun;
  if (bun?.Transpiler === undefined) return code;
  return new bun.Transpiler({ loader: "ts" }).transformSync(code);
};

/**
 * The model writes a function BODY (top-level `return` and all), which
 * a module-level transpiler rejects — so wrap it into a NAMED async
 * function declaration first (a bare expression statement would be
 * dead-code eliminated by Bun's transpiler), transpile, and evaluate
 * the declaration back into a callable.
 *
 * `Effect` and `console` are in scope so the effect convention can
 * reference the runtime and either convention can log — the evaluator
 * stays convention-agnostic; it just makes them available.
 */
const compileBody = (
  body: string,
): ((
  tools: unknown,
  Effect: unknown,
  console: unknown,
) => Promise<unknown>) => {
  const wrapped = transpile(
    `async function __body__(tools, Effect, console) {\n${body}\n}`,
  );
  return new Function(`${wrapped}\nreturn __body__;`)() as (
    tools: unknown,
    Effect: unknown,
    console: unknown,
  ) => Promise<unknown>;
};

const format = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));

/**
 * The IN-PROCESS {@link Eval}: `new Function` over the local runtime
 * (TypeScript stripped via `Bun.Transpiler` when available). Tools are
 * exposed as async stubs that run the granted Effect handlers via
 * `Effect.runPromise`; `console` output is captured into the result's
 * logs; the `Effect` runtime is in scope for the effect convention.
 *
 * Fine for a local org; NOT an isolation boundary — the code shares
 * the driver's process. A Cloudflare WorkerLoader evaluator is the
 * isolated substrate behind the same contract.
 */
export const EvalFunction: Layer.Layer<Eval> = Layer.succeed(Eval, {
  run: ({ code, tools, timeout }) =>
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const record =
        (level: string) =>
        (...args: Array<unknown>) =>
          logs.push(
            `${level === "log" ? "" : `[${level}] `}${args.map(format).join(" ")}`,
          );
      const capturedConsole = {
        log: record("log"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
        debug: record("debug"),
      };
      const bridge = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          (input: unknown) =>
            Effect.runPromise(tool.call(input) as Effect.Effect<unknown>),
        ]),
      );
      const fn = yield* Effect.try({
        try: () => compileBody(code),
        catch: (error) => `code did not evaluate: ${error}`,
      });
      const output = yield* Effect.tryPromise({
        try: () => fn(bridge, Effect, capturedConsole),
        catch: (error) => `program failed: ${error}`,
      });
      return { output, logs };
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            `eval timed out after ${Duration.format(
              Duration.fromInputUnsafe(timeout),
            )} — split the work into smaller programs`,
          ),
      }),
    ),
});
