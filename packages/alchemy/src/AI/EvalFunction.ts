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
 * a module-level transpiler rejects — so wrap it into a NAMED function
 * declaration first (a bare expression statement would be dead-code
 * eliminated by Bun's transpiler), transpile, and evaluate the
 * declaration back into a callable.
 */
const compileBody = (body: string): ((tools: unknown) => Promise<unknown>) => {
  const wrapped = transpile(`async function __body__(tools) {\n${body}\n}`);
  return new Function(`${wrapped}\nreturn __body__;`)() as (
    tools: unknown,
  ) => Promise<unknown>;
};

/**
 * The IN-PROCESS {@link Eval}: `new Function` over the local runtime,
 * TypeScript stripped via `Bun.Transpiler` when available. Tools are
 * bridged as async stubs that run the granted Effect handlers via
 * `Effect.runPromise`.
 *
 * Fine for a local org; NOT an isolation boundary — the code shares
 * the driver's process. Cloudflare's `EvalWorkerLoader` is the
 * isolated substrate behind the same contract.
 */
export const EvalFunction: Layer.Layer<Eval> = Layer.succeed(Eval, {
  run: ({ code, tools, timeout }) =>
    Effect.gen(function* () {
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
      return yield* Effect.tryPromise({
        try: () => fn(bridge),
        catch: (error) => `program failed: ${error}`,
      });
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
