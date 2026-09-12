import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";

/**
 * One capability the evaluated program may call, by name. `call` runs
 * the real granted handler; the {@link Eval} implementation decides how
 * a call from inside the program reaches it — a direct closure
 * in-process, or an RPC across an isolate boundary.
 *
 * Inputs and outputs are JSON-serializable by contract: an evaluator
 * that runs the program in a separate isolate (a loaded Worker, a
 * remote sandbox) marshals them across the wire, so live objects,
 * functions, and Effects cannot cross as tool arguments or results.
 */
export interface EvalTool {
  readonly name: string;
  readonly call: (input: unknown) => Effect.Effect<unknown, unknown>;
}

/** What one evaluation produced: the program's settled value and
 *  whatever it wrote to `console` while running. */
export interface EvalResult {
  readonly output: unknown;
  readonly logs: ReadonlyArray<string>;
}

/**
 * EVALUATE A JAVASCRIPT MODULE GRAPH — the pluggable interpreter
 * behind {@link CodeMode}. The request is a set of ES modules
 * (`modules`, name → source) and the entry (`main`), whose DEFAULT
 * export is an async thunk `() => Promise<output>`; the evaluator
 * links the graph, invokes the thunk, and returns the settled value
 * plus captured `console` output — or a model-visible error string.
 *
 * The reserved module name `"tools.raw.js"` is PROVIDED BY THE
 * EVALUATOR: one named async function per granted tool, each bridging
 * to the corresponding {@link EvalTool} handler (a rejected call
 * carries the tool's declared failure, `_tag` intact). Conventions
 * build on it — the module the model actually imports (`"./tools.js"`)
 * is part of the request, re-exporting or adapting the raw bridges to
 * the convention's shape.
 *
 * The interface says nothing about WHERE the graph runs or WHAT
 * convention the program is written in: an in-process data-URL loader,
 * a Cloudflare dynamic worker, a remote sandbox all satisfy it, and
 * CodeMode owns the convention (it shapes the module graph before
 * handing it here). The evaluator is dumb: link modules, run the
 * thunk, return `{ output, logs }` or an error.
 *
 * ```ts
 * AI.CodeModeAsync().pipe(Layer.provide(AI.EvalFunction))
 * AI.CodeModeEffect().pipe(Layer.provide(AI.EvalFunction))
 * // or any other Eval — Cloudflare.AI.EvalWorkerLoader, e2b — behind
 * // the same contract
 * ```
 */
export class Eval extends Context.Service<
  Eval,
  {
    readonly run: (request: {
      /**
       * The module graph, name → ES module source. Relative imports
       * resolve between entries (`"./program.js"` → `"program.js"`);
       * `"tools.raw.js"` is reserved for the evaluator's tool bridges.
       */
      readonly modules: Record<string, string>;
      /** The entry module; its default export is the program thunk. */
      readonly main: string;
      /** The capabilities behind the reserved `"tools.raw.js"` module. */
      readonly tools: ReadonlyArray<EvalTool>;
      /** Wall-clock budget for the whole program. */
      readonly timeout: Duration.Input;
    }) => Effect.Effect<EvalResult, string>;
  }
>()("alchemy/AI/Eval") {}

/** The reserved module name for the evaluator-provided tool bridges. */
export const TOOLS_RAW_MODULE = "tools.raw.js";
