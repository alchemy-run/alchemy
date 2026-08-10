import type * as Layer from "effect/Layer";
import { markdown } from "../Code/Markdown.ts";
import { typescript } from "../Code/TypeScript.ts";
import { makeCodeMode, type CodeModeOptions } from "./CodeMode.ts";
import type { Eval } from "./Eval.ts";
import type { ToolEngine } from "./ToolEngine.ts";

/**
 * The `"./tools.js"` adapter: re-shape the evaluator's raw async
 * bridges into Effect-returning capabilities. A rejected bridge call
 * carries the tool's DECLARED failure (`_tag` intact — in-process it
 * is the failure value itself; across an isolate it is reconstructed
 * from JSON), and `tryPromise`'s identity catch makes it the Effect's
 * typed failure channel, so `Effect.catchTag("TheTag", …)` works
 * inside the program.
 */
const toolsAdapter = (names: ReadonlyArray<string>): string =>
  typescript`
    import * as Effect from "effect/Effect";
    import * as raw from "./tools.raw.js";

    const lift = (call) => (input) =>
      Effect.tryPromise({ try: () => call(input), catch: (error) => error });

    ${names.map((name) => `export const ${name} = lift(raw.${name});`).join("\n")}
  `;

/**
 * CODEMODE, EFFECT convention — the model writes a COMPLETE module
 * that default-exports an `Effect` program: capabilities imported
 * from `"./tools.js"` are Effect-returning, composed with
 * `Effect.gen`/`yield*`, and the program's result becomes the tool
 * result. Declared tool failures are the Effect's typed error channel
 * (catch them by tag); `effect/*` modules are importable when the
 * evaluator provides the runtime (`AI.EvalFunction` resolves them
 * natively in-process; `Cloudflare.AI.EvalWorkerLoaderEffect` ships
 * them into the isolate).
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
    // model module verbatim; the runner runs its default-exported
    // Effect — the evaluator stays convention-blind
    program: (code, toolNames) => ({
      main: "main.js",
      modules: {
        "tools.js": toolsAdapter(toolNames),
        "program.js": code,
        "main.js": typescript`
          import * as Effect from "effect/Effect";
          import program from "./program.js";
          export default () => Effect.runPromise(program);
        `,
      },
    }),
    teach: (signatures) => markdown`
      Run a program against your capabilities instead of calling them one
      at a time. Write a COMPLETE JavaScript module that default-exports
      an Effect:

      \`\`\`js
      import * as Effect from "effect/Effect";
      import { someTool } from "./tools.js";

      export default Effect.gen(function* () {
        const result = yield* someTool({ ... });
        return result; // becomes your tool result
      });
      \`\`\`

      Compose with yield*, ordinary control flow, and Effect.forEach for
      concurrency; console.log surfaces intermediate values. Importable
      modules: "./tools.js" and the effect runtime ("effect/Effect",
      "effect/Data", "effect/Duration", "effect/Schedule", ...). No type
      annotations.

      A tool's declared errors are its signature's error channel — catch
      them by tag (Effect.catchTag) or let them fail the program;
      anything undeclared is a defect.

      Available capabilities (import from "./tools.js"):

      ${signatures}
    `,
  });
