import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as AiTool from "effect/unstable/ai/Tool";
import { Eval, type EvalResult, type EvalTool } from "./Eval.ts";
import {
  ToolEngine,
  type ToolGrant,
  type ToolPresentation,
} from "./ToolEngine.ts";

// ── JSON schema → TS-ish signature text ─────────────────────────────

const renderType = (schema: any, depth = 0): string => {
  if (schema === undefined || schema === null || depth > 6) return "unknown";
  if (schema.$ref !== undefined) return "unknown";
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf
      .map((member: any) => renderType(member, depth + 1))
      .join(" | ");
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value: any) => JSON.stringify(value)).join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${renderType(schema.items, depth + 1)}>`;
    case "object": {
      const properties = schema.properties ?? {};
      const required = new Set<string>(schema.required ?? []);
      const fields = Object.entries(properties).map(
        ([key, value]) =>
          `${key}${required.has(key) ? "" : "?"}: ${renderType(value, depth + 1)}`,
      );
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }
    default:
      return "unknown";
  }
};

/** One `declare function` line per grant, with its doc as a comment.
 *  `wrap` reflects the convention's return shape (`Promise` vs
 *  `Effect`). */
const renderSignature = (
  grant: ToolGrant,
  wrap: (returns: string) => string,
): string => {
  const doc = grant.description
    .split("\n")
    .map((line) => `// ${line}`)
    .join("\n");
  return `${doc}\ndeclare function ${grant.name}(input: ${renderType(
    grant.parameters,
  )}): ${wrap(renderType(grant.returns))}`;
};

/** Render an eval result as the tool result the model reads —
 *  the output, plus captured console logs when the program printed. */
const renderResult = (result: EvalResult): string => {
  const output =
    result.output === undefined
      ? "undefined"
      : typeof result.output === "string"
        ? result.output
        : (JSON.stringify(result.output, null, 2) ?? String(result.output));
  return result.logs.length === 0
    ? output
    : `${output}\n\n--- logs ---\n${result.logs.join("\n")}`;
};

const compileEvalTool = (description: string) =>
  AiTool.make("eval", {
    description,
    parameters: S.Struct({ code: S.String }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  }).annotate(AiTool.Strict, false);

export interface CodeModeOptions {
  /**
   * Wall-clock budget for one `eval` call.
   * @default "120 seconds"
   */
  readonly timeout?: Duration.Input;
}

/**
 * One CODEMODE convention — a {@link ToolEngine} that collapses a
 * tick's grants into ONE `eval` tool and delegates execution to the
 * {@link Eval} service. It owns the CONVENTION entirely:
 *
 * - `wrap` — the return shape in the generated signatures;
 * - `teach` — how the model is instructed to write the program;
 * - `wrapCode` — transforms the model's body into the async body
 *   `Eval` runs (the effect convention re-shapes `tools` into
 *   Effect-returning and runs the returned Effect here, so `Eval`
 *   never learns which convention called it).
 */
const makeCodeMode = (convention: {
  readonly wrap: (returns: string) => string;
  readonly teach: (signatures: string) => string;
  readonly wrapCode: (body: string) => string;
  readonly options?: CodeModeOptions;
}): Layer.Layer<ToolEngine, never, Eval> =>
  Layer.effect(
    ToolEngine,
    Effect.map(Eval, (evaluator) => ({
      present: (grants) =>
        Effect.sync((): ToolPresentation => {
          const signatures = grants
            .map((grant) => renderSignature(grant, convention.wrap))
            .join("\n\n");
          const timeout = convention.options?.timeout ?? "120 seconds";
          const tools: ReadonlyArray<EvalTool> = grants.map((grant) => ({
            name: grant.name,
            call: grant.handler,
          }));
          return {
            tools: [compileEvalTool(convention.teach(signatures))],
            handlers: {
              eval: (input: { code: string }) =>
                evaluator
                  .run({
                    code: convention.wrapCode(input.code),
                    tools,
                    timeout,
                  })
                  .pipe(Effect.map(renderResult)) as Effect.Effect<string, any>,
            },
          };
        }),
    })),
  );

/**
 * CODEMODE, ASYNC convention — the model writes the BODY of an async
 * function with `tools` in scope: `await` tool calls, compose with
 * ordinary control flow, `return` the result. Portable: pair with any
 * {@link Eval} — `EvalFunction` in-process, or a WorkerLoader across
 * an isolate.
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
    // the model's body already targets async tools — run it as-is
    wrapCode: (body) => body,
    teach: (signatures) =>
      `Run a program against your capabilities instead of calling them ` +
      `one at a time. Write the BODY of an async JavaScript function ` +
      `with \`tools\` in scope: await tool calls, compose with ordinary ` +
      `control flow, and \`return\` the result — it becomes your tool ` +
      `result. Use console.log to surface intermediate values. No ` +
      `imports, no type annotations. A rejected tool call throws; ` +
      `catch it or let it fail the program.\n\nAvailable capabilities ` +
      `(call as tools.<name>):\n\n${signatures}`,
  });

/**
 * CODEMODE, EFFECT convention — the model writes the BODY of a
 * function returning an `Effect`: `tools.<name>` are Effect-returning,
 * compose with `Effect.gen`/`yield*`/`Effect.forEach`, and the
 * returned Effect's result becomes the tool result.
 *
 * The convention is entirely CodeMode's: it re-shapes the evaluator's
 * async `tools` into Effect-returning ones and runs the returned
 * Effect, so a dumb {@link Eval} never learns about Effect. `Eval`
 * must expose the `Effect` runtime in scope (`EvalFunction` does);
 * pair accordingly.
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
