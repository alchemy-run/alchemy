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

/**
 * One `declare function` line per grant, with its doc as a comment —
 * plus a line per DECLARED failure, so the model can see what a call
 * may fail with and handle it. `wrap` reflects the convention's return
 * shape: it receives the success type and the union of error tags
 * (`never` when the tool declares none).
 */
const renderSignature = (
  grant: ToolGrant,
  wrap: (returns: string, errors: string) => string,
): string => {
  const lines = grant.description.split("\n");
  for (const error of grant.errors) {
    lines.push(
      error.fields === undefined
        ? `@throws ${error.tag}`
        : `@throws ${error.tag} ${renderType(error.fields)}`,
    );
  }
  const doc = lines.map((line) => `// ${line}`).join("\n");
  const errors =
    grant.errors.length === 0
      ? "never"
      : grant.errors.map((error) => error.tag).join(" | ");
  return `${doc}\ndeclare function ${grant.name}(input: ${renderType(
    grant.parameters,
  )}): ${wrap(renderType(grant.returns), errors)}`;
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
 * - `teach` — how the model is instructed to write the program (a
 *   COMPLETE ES module importing its capabilities from `"./tools.js"`
 *   and default-exporting the program);
 * - `program` — builds the module graph `Eval` runs from the model's
 *   module: a `"tools.js"` adapter over the evaluator's reserved
 *   `"tools.raw.js"` bridges (the effect convention re-shapes them
 *   into Effect-returning), the model's code verbatim as
 *   `"program.js"`, and a runner whose default export is the async
 *   thunk the evaluator invokes — so `Eval` never learns which
 *   convention called it.
 */
export const makeCodeMode = (convention: {
  readonly wrap: (returns: string, errors: string) => string;
  readonly teach: (signatures: string) => string;
  readonly program: (
    code: string,
    toolNames: ReadonlyArray<string>,
  ) => {
    readonly modules: Record<string, string>;
    readonly main: string;
  };
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
          const toolNames = grants.map((grant) => grant.name);
          return {
            tools: [compileEvalTool(convention.teach(signatures))],
            handlers: {
              eval: (input: { code: string }) =>
                evaluator
                  .run({
                    ...convention.program(input.code, toolNames),
                    tools,
                    timeout,
                  })
                  .pipe(Effect.map(renderResult)) as Effect.Effect<string, any>,
            },
          };
        }),
    })),
  );
