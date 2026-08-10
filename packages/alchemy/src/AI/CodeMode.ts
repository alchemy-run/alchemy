import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as AiTool from "effect/unstable/ai/Tool";
import { Eval, type EvalTool } from "./Eval.ts";
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

/** One `declare function` line per grant, with its doc as a comment. */
const renderSignature = (grant: ToolGrant): string => {
  const doc = grant.description
    .split("\n")
    .map((line) => `// ${line}`)
    .join("\n");
  return `${doc}\ndeclare function ${grant.name}(input: ${renderType(
    grant.parameters,
  )}): Promise<${renderType(grant.returns)}>`;
};

/** Render an eval result as a tool result the model reads. */
const renderResult = (value: unknown): string =>
  value === undefined
    ? "undefined"
    : typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));

const compileEvalTool = (description: string) =>
  AiTool.make("eval", {
    description,
    parameters: S.Struct({ code: S.String }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  }).annotate(AiTool.Strict, false);

const teach = (signatures: string): string =>
  `Run a program against your capabilities instead of calling them ` +
  `one at a time. Write the BODY of an async JavaScript function ` +
  `with \`tools\` in scope: await tool calls, compose with ordinary ` +
  `control flow, and \`return\` the result — it becomes your tool ` +
  `result. No imports, no type annotations. A rejected tool call ` +
  `throws; catch it or let it fail the program.\n\nAvailable ` +
  `capabilities (call as tools.<name>):\n\n${signatures}`;

export interface CodeModeOptions {
  /**
   * Wall-clock budget for one `eval` call.
   * @default "120 seconds"
   */
  readonly timeout?: Duration.Input;
}

/**
 * CODEMODE — a {@link ToolEngine} that collapses a tick's grants into
 * ONE `eval` tool: instead of round-tripping every call through the
 * model, the model writes CODE (the body of an async function with
 * `tools` in scope) that calls the granted capabilities and composes
 * them with ordinary control flow. The `eval` tool's description is
 * the generated TypeScript signatures of this tick's grants —
 * mention-is-presence decides exactly what the code can reach.
 *
 * WHERE the code runs is the pluggable {@link Eval} service, resolved
 * at layer build: `EvalFunction` in-process locally, a WorkerLoader
 * isolate on Cloudflare. CodeMode owns only the PRESENTATION (teach
 * the model, generate signatures, render the result); execution is
 * `Eval`'s.
 *
 * ```ts
 * IssuesLive.pipe(Layer.provide(AI.CodeMode().pipe(Layer.provide(AI.EvalFunction))))
 * // provide no ToolEngine at all: direct tool-calling, exactly as before
 * ```
 *
 * Driver intrinsics (`dispatch`, `spawn`, `skill`) stay direct tools —
 * they are conversation control, not capabilities.
 */
export const CodeMode = (
  options?: CodeModeOptions,
): Layer.Layer<ToolEngine, never, Eval> =>
  Layer.effect(
    ToolEngine,
    Effect.map(Eval, (evaluator) => ({
      present: (grants) =>
        Effect.sync((): ToolPresentation => {
          const signatures = grants.map(renderSignature).join("\n\n");
          const timeout = options?.timeout ?? "120 seconds";
          const tools: ReadonlyArray<EvalTool> = grants.map((grant) => ({
            name: grant.name,
            call: grant.handler,
          }));
          return {
            tools: [compileEvalTool(teach(signatures))],
            handlers: {
              eval: (input: { code: string }) =>
                evaluator
                  .run({ code: input.code, tools, timeout })
                  .pipe(Effect.map(renderResult)) as Effect.Effect<string, any>,
            },
          };
        }),
    })),
  );
