import type * as Layer from "effect/Layer";
import { makeCodeMode, type CodeModeOptions } from "./CodeMode.ts";
import type { Eval } from "./Eval.ts";
import type { ToolEngine } from "./ToolEngine.ts";

/**
 * CODEMODE, EFFECT convention — the model writes the BODY of a
 * function returning an `Effect`: `tools.<name>` are Effect-returning,
 * compose with `Effect.gen`/`yield*`/`Effect.forEach`, and the
 * returned Effect's result becomes the tool result.
 *
 * The convention is entirely this engine's: `wrapCode` re-shapes the
 * evaluator's async `tools` into Effect-returning ones and runs the
 * model's Effect, so a dumb {@link Eval} never learns about Effect.
 * It does require the `Effect` runtime in the evaluator's scope
 * (`EvalFunction` provides it); pair accordingly.
 *
 * ```ts
 * IssuesLive.pipe(Layer.provide(AI.CodeModeEffect().pipe(Layer.provide(AI.EvalFunction))))
 * ```
 */
export const CodeModeEffect = (
  options?: CodeModeOptions,
): Layer.Layer<ToolEngine, never, Eval> =>
  makeCodeMode({
    options,
    wrap: (type) => `Effect<${type}>`,
    // re-shape the evaluator's async tools into Effect-returning ones,
    // run the model's returned Effect, and hand `Eval` the awaited
    // result — the evaluator stays convention-blind
    wrapCode: (body) =>
      `const __asyncTools = tools;\n` +
      `tools = Object.fromEntries(\n` +
      `  Object.entries(__asyncTools).map(([__k, __f]) => [\n` +
      `    __k,\n` +
      `    (input) => Effect.promise(() => __f(input)),\n` +
      `  ]),\n` +
      `);\n` +
      `const __program = (function () {\n${body}\n})();\n` +
      `return await Effect.runPromise(__program);`,
    teach: (signatures) =>
      `Run a program against your capabilities instead of calling them ` +
      `one at a time. Write the BODY of a JavaScript function: it must ` +
      `\`return\` an Effect — use Effect.gen(function* () { ... }) with ` +
      `yield* on every tool call, and compose with ordinary control ` +
      `flow (loops, conditionals, Effect.forEach for concurrency). Use ` +
      `console.log to surface intermediate values. No imports, no type ` +
      `annotations. The returned Effect's result becomes your tool ` +
      `result; a failed tool call fails the program unless you handle ` +
      `it (Effect.catch).\n\nAvailable capabilities (call as ` +
      `tools.<name>):\n\n${signatures}`,
  });
