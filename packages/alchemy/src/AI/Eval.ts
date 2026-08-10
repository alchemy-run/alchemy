import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";

/**
 * One capability the evaluated code may call, by name. `call` runs the
 * real granted handler; the {@link Eval} implementation decides how a
 * `tools.<name>(input)` reference inside the code reaches it — a direct
 * closure in-process, or an RPC across an isolate boundary.
 *
 * Inputs and outputs are JSON-serializable by contract: an evaluator
 * that runs the code in a separate isolate (a loaded Worker, a remote
 * sandbox) marshals them across the wire, so live objects, functions,
 * and Effects cannot cross as tool arguments or results.
 */
export interface EvalTool {
  readonly name: string;
  readonly call: (input: unknown) => Effect.Effect<unknown, unknown>;
}

/** What one evaluation produced: the program's return value and
 *  whatever it wrote to `console` while running. */
export interface EvalResult {
  readonly output: unknown;
  readonly logs: ReadonlyArray<string>;
}

/**
 * EVALUATE JAVASCRIPT — the pluggable code interpreter behind
 * {@link CodeMode}. Run `code` (an async function body with `tools` in
 * scope), await its result, and return the output plus captured
 * console logs — or a model-visible error string.
 *
 * The interface says nothing about WHERE it runs or WHAT convention
 * the code is written in: in-process `new Function`, a Cloudflare
 * WorkerLoader, a remote sandbox all satisfy it, and CodeMode owns the
 * convention (it shapes the `code` and the `tools` before handing them
 * here). The evaluator is dumb: run JS, return `{ output, logs }` or
 * an error.
 *
 * ```ts
 * AI.CodeModeAsync().pipe(Layer.provide(AI.EvalFunction))
 * AI.CodeModeEffect().pipe(Layer.provide(AI.EvalFunction))
 * // or any other Eval — WorkerLoader, e2b — behind the same contract
 * ```
 */
export class Eval extends Context.Service<
  Eval,
  {
    readonly run: (request: {
      /** The async function body to evaluate (`tools` in scope). */
      readonly code: string;
      /** The capabilities exposed inside the code as `tools.<name>`. */
      readonly tools: ReadonlyArray<EvalTool>;
      /** Wall-clock budget for the whole program. */
      readonly timeout: Duration.Input;
    }) => Effect.Effect<EvalResult, string>;
  }
>()("alchemy/AI/Eval") {}
