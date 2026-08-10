import type * as Layer from "effect/Layer";
import { dedent } from "../Util/dedent.ts";
import { makeCodeMode, type CodeModeOptions } from "./CodeMode.ts";
import type { Eval } from "./Eval.ts";
import type { ToolEngine } from "./ToolEngine.ts";

/**
 * CODEMODE, ASYNC convention — the model writes the BODY of an async
 * function with `tools` in scope: `await` tool calls, compose with
 * ordinary control flow, `return` the result. Portable: pair with any
 * {@link Eval} — `EvalFunction` in-process, or a WorkerLoader across
 * an isolate (promises are all that need to cross).
 *
 * ```ts
 * IssuesLive.pipe(Layer.provide(AI.CodeModeAsync().pipe(Layer.provide(AI.EvalFunction))))
 * ```
 *
 * Driver intrinsics (`dispatch`, `spawn`, `skill`) stay direct tools —
 * they are conversation control, not capabilities. Provide no
 * ToolEngine at all for plain one-at-a-time tool calling.
 */
export const CodeModeAsync = (
  options?: CodeModeOptions,
): Layer.Layer<ToolEngine, never, Eval> =>
  makeCodeMode({
    options,
    wrap: (type) => `Promise<${type}>`,
    // the model's body already targets the evaluator's async tools —
    // hand it over as-is
    wrapCode: (body) => body,
    teach: (signatures) => dedent`
      Run a program against your capabilities instead of calling them one
      at a time. Write the BODY of an async JavaScript function with
      \`tools\` in scope: await tool calls, compose with ordinary control
      flow, and \`return\` the result — it becomes your tool result. Use
      console.log to surface intermediate values. No imports, no type
      annotations.

      A tool's declared errors are in its signature's error channel and
      reject the promise — catch them or let them fail the program;
      anything undeclared is a defect.

      Available capabilities (call as tools.<name>):

      ${signatures}
    `,
  });
