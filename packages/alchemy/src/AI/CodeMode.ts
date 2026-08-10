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
export const makeCodeMode = (convention: {
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
