import type * as Layer from "effect/Layer";
import { dedent } from "../Util/dedent.ts";
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
    // the declared failures ARE the error channel; R is always never —
    // the program cannot require services
    wrap: (type, errors) => `Effect<${type}, ${errors}>`,
    // re-shape the evaluator's async tools into Effect-returning ones,
    // run the model's returned Effect, and hand `Eval` the awaited
    // result — the evaluator stays convention-blind
    // the model's body is SPLICED between two dedented halves, never
    // interpolated into one: its own indentation is arbitrary, and
    // dedent would take its margin from that
    wrapCode: (body) =>
      [
        dedent`
          const __asyncTools = tools;
          tools = Object.fromEntries(
            Object.entries(__asyncTools).map(([__k, __f]) => [
              __k,
              (input) => Effect.promise(() => __f(input)),
            ]),
          );
          const __program = (function () {
        `,
        body,
        dedent`
          })();
          return await Effect.runPromise(__program);
        `,
      ].join("\n"),
    teach: (signatures) =>
      `${dedent`
        Run a program against your capabilities instead of calling them one
        at a time. Write the BODY of a JavaScript function: it must \`return\`
        an Effect — use Effect.gen(function* () { ... }) with yield* on every
        tool call, and compose with ordinary control flow (loops,
        conditionals, Effect.forEach for concurrency). Use console.log to
        surface intermediate values. No imports, no type annotations.

        The returned Effect's result becomes your tool result. A tool's
        declared errors are its signature's error channel — handle them with
        Effect.catch or let them fail the program; anything undeclared is a
        defect.

        Available capabilities (call as tools.<name>):
      `}\n\n${signatures}`,
  });
