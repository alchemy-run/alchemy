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
 * that runs the code in a separate isolate (a loaded Worker) marshals
 * them across the wire, so live objects, functions, and Effects cannot
 * cross.
 */
export interface EvalTool {
  readonly name: string;
  readonly call: (input: unknown) => Effect.Effect<unknown, unknown>;
}

/**
 * WHERE CODE RUNS — the pluggable evaluator behind {@link CodeMode}.
 * Given a program (the body of an async function with `tools` in
 * scope) and the capabilities it may call, run it and return the
 * result. The code sees ASYNC stubs (`tools.<name>(input): Promise`),
 * because promises are what cross an isolate boundary.
 *
 * The substrate is a Layer choice, never a CodeMode choice:
 *
 * ```ts
 * AI.CodeMode().pipe(Layer.provide(AI.EvalFunction))        // in-process
 * AI.CodeMode().pipe(Layer.provide(Cloudflare.AI.EvalWorkerLoader)) // isolated
 * ```
 *
 * A failure is a MODEL-VISIBLE string (the program's error, a timeout,
 * a compile error) — codemode reports it as the `eval` tool result and
 * the model reacts; it is never a loop crash.
 */
export class Eval extends Context.Service<
  Eval,
  {
    readonly run: (request: {
      /** The async function body the model wrote. */
      readonly code: string;
      /** The capabilities in scope, bridged into `tools.<name>`. */
      readonly tools: ReadonlyArray<EvalTool>;
      /** Wall-clock budget for the whole program. */
      readonly timeout: Duration.Input;
    }) => Effect.Effect<unknown, string>;
  }
>()("alchemy/AI/Eval") {}
