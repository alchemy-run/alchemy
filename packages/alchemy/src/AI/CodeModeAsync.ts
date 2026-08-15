import type * as Layer from "effect/Layer";
import { markdown } from "../Code/Markdown.ts";
import { typescript } from "../Code/TypeScript.ts";
import { makeCodeMode, type CodeModeOptions } from "./CodeMode.ts";
import type { Eval } from "./Eval.ts";
import type { Tools } from "./Tools.ts";

/**
 * CODEMODE, ASYNC convention — the model writes a COMPLETE JavaScript
 * module: named capability imports from `"./tools.js"`, then
 * `export default async function () { ... }` whose return value
 * becomes the tool result. Portable: pair with any {@link Eval} —
 * `EvalFunction` in-process, or `Cloudflare.AI.EvalWorkerLoader`
 * across an isolate (promises are all that need to cross).
 *
 * ```ts
 * IssuesLive.pipe(Layer.provide(AI.CodeModeAsync().pipe(Layer.provide(AI.EvalFunction))))
 * ```
 *
 * Driver intrinsics (`dispatch`, `spawn`, `skill`) stay direct tools —
 * they are conversation control, not capabilities. Provide no
 * Tools at all for plain one-at-a-time tool calling.
 */
export const CodeModeAsync = (
  options?: CodeModeOptions,
): Layer.Layer<Tools, never, Eval> =>
  makeCodeMode({
    options,
    // a rejection carries the declared error; the tags are listed as
    // `@throws` lines in the signature's doc comment
    wrap: (type) => `Promise<${type}>`,
    // the model's module already targets the evaluator's async tool
    // bridges — "./tools.js" re-exports them as-is, and the runner's
    // thunk simply invokes the default export
    program: (code) => ({
      main: "main.js",
      modules: {
        "tools.js": typescript`
          export * from "./tools.raw.js";
        `,
        "program.js": code,
        "main.js": typescript`
          import program from "./program.js";
          export default () => program();
        `,
      },
    }),
    teach: (signatures) => markdown`
      Run a program against your capabilities instead of calling them one
      at a time. Write a COMPLETE JavaScript module:

      \`\`\`js
      import { someTool } from "./tools.js";

      export default async function () {
        const result = await someTool({ ... });
        return result; // becomes your tool result
      }
      \`\`\`

      Await tool calls, compose with ordinary control flow, and return
      the result. Use console.log to surface intermediate values. Only
      "./tools.js" is importable; no type annotations.

      A tool's declared errors (the @throws lines below) reject the
      promise — catch them or let them fail the program; anything
      undeclared is a defect.

      Available capabilities (import from "./tools.js"):

      ${signatures}
    `,
  });
