/**
 * CODEMODE: the {@link WireMode} implementations that collapse a
 * tick's grants into ONE `eval` tool — the model writes CODE that
 * calls the granted capabilities and composes them with ordinary
 * control flow, instead of round-tripping every call through the
 * model. Two flavors, one seam:
 *
 * - {@link CodeModeEffect} — the code returns an `Effect`; tools are
 *   Effect-returning functions, so the whole program stays on the
 *   driver's fiber (interruption and tracing intact).
 * - {@link CodeModeAsync} — the code is an async function body; tools
 *   return Promises.
 *
 * The bridge is the enforcement point: the ONLY functions in scope are
 * this tick's granted handlers — mention-is-presence decides what the
 * code can reach, exactly as it decides direct tool-calling.
 *
 * v0 EVALUATION IS IN-PROCESS (`new Function` over the local runtime,
 * TypeScript stripped via `Bun.Transpiler` when available) — fine for
 * a local org, NOT an isolation boundary. The sandbox-as-service seam
 * (spec §13) replaces the evaluator without touching this contract.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as AiTool from "effect/unstable/ai/Tool";
import { WireMode, type WireGrant, type WirePresentation } from "./WireMode.ts";

/**
 * Codemode, EFFECT flavor: the model's code is the body of a function
 * `(Effect, tools) => Effect<A>` — tools are Effect-returning, the
 * program composes with `Effect.gen`/`pipe`, and evaluation stays on
 * the driver's fiber (a failed tool call is a typed failure the
 * program can catch or let propagate as the eval result).
 */
export const CodeModeEffect = (options?: CodeModeOptions) =>
  makeCodeMode({
    options,
    wrapReturn: (type) => `Effect<${type}>`,
    teach: (signatures) =>
      `Run a program against your capabilities instead of calling them ` +
      `one at a time. Write the BODY of a JavaScript function receiving ` +
      `(Effect, tools): it must \`return\` an Effect — use ` +
      `Effect.gen(function* () { ... }) with yield* on every tool call, ` +
      `and compose with ordinary control flow (loops, conditionals, ` +
      `Effect.forEach for concurrency). No imports, no type annotations. ` +
      `The returned Effect's result becomes your tool result; a failed ` +
      `tool call fails the program unless you handle it ` +
      `(Effect.catch).\n\nAvailable capabilities (call as ` +
      `tools.<name>):\n\n${signatures}`,
    evaluate: (code, grants) =>
      Effect.gen(function* () {
        const tools = Object.fromEntries(
          grants.map((grant) => [grant.name, grant.handler]),
        );
        const program = yield* Effect.try({
          try: () => compileBody("Effect, tools", code, false)(Effect, tools),
          catch: (error) => `code did not evaluate: ${error}`,
        });
        if (!Effect.isEffect(program)) {
          return yield* Effect.fail(
            "the code must `return` an Effect (e.g. `return Effect.gen(function* () { ... })`)",
          );
        }
        return yield* (program as Effect.Effect<unknown>).pipe(
          Effect.catch((error) => Effect.fail(`program failed: ${error}`)),
        );
      }),
  });

/**
 * Codemode, ASYNC flavor: the model's code is an async function body
 * with `tools` in scope — every capability returns a Promise; `await`
 * and compose freely; `return` the result.
 */
export const CodeModeAsync = (options?: CodeModeOptions) =>
  makeCodeMode({
    options,
    wrapReturn: (type) => `Promise<${type}>`,
    teach: (signatures) =>
      `Run a program against your capabilities instead of calling them ` +
      `one at a time. Write the BODY of an async JavaScript function ` +
      `with \`tools\` in scope: await tool calls, compose with ordinary ` +
      `control flow, and \`return\` the result — it becomes your tool ` +
      `result. No imports, no type annotations. A rejected tool call ` +
      `throws; catch it or let it fail the program.\n\nAvailable ` +
      `capabilities (call as tools.<name>):\n\n${signatures}`,
    evaluate: (code, grants) =>
      Effect.gen(function* () {
        const tools = Object.fromEntries(
          grants.map((grant) => [
            grant.name,
            (input: unknown) =>
              Effect.runPromise(grant.handler(input) as Effect.Effect<unknown>),
          ]),
        );
        const fn = yield* Effect.try({
          try: () => compileBody("tools", code, true),
          catch: (error) => `code did not evaluate: ${error}`,
        });
        return yield* Effect.tryPromise({
          try: () => fn(tools),
          catch: (error) => `program failed: ${error}`,
        });
      }),
  });

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
const renderSignature = (
  grant: WireGrant,
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

// ── evaluation ───────────────────────────────────────────────────────

/** Strip TypeScript annotations when running under bun; else run as-is. */
const transpile = (code: string): string => {
  const bun = (globalThis as any).Bun;
  if (bun?.Transpiler === undefined) return code;
  return new bun.Transpiler({ loader: "ts" }).transformSync(code);
};

/**
 * The model writes a function BODY (top-level `return` and all), which
 * a module-level transpiler rejects — so wrap it into a NAMED function
 * declaration first (a bare expression statement would be dead-code
 * eliminated by Bun's transpiler), transpile, and evaluate the
 * declaration back into a callable.
 */
const compileBody = (
  params: string,
  body: string,
  async: boolean,
): ((...args: any[]) => any) => {
  const wrapped = transpile(
    `${async ? "async " : ""}function __body__(${params}) {\n${body}\n}`,
  );
  return new Function(`${wrapped}\nreturn __body__;`)() as (
    ...args: any[]
  ) => any;
};

/** Render an eval result as a tool result the model reads. */
const renderResult = (value: unknown): string =>
  value === undefined
    ? "undefined"
    : typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));

export interface CodeModeOptions {
  /**
   * Wall-clock budget for one `eval` call.
   * @default "120 seconds"
   */
  readonly timeout?: Duration.Input;
}

const compileEvalTool = (description: string) =>
  AiTool.make("eval", {
    description,
    parameters: S.Struct({ code: S.String }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  }).annotate(AiTool.Strict, false);

const makeCodeMode = (flavor: {
  readonly wrapReturn: (type: string) => string;
  readonly teach: (signatures: string) => string;
  readonly evaluate: (
    code: string,
    grants: ReadonlyArray<WireGrant>,
  ) => Effect.Effect<unknown, string>;
  readonly options?: CodeModeOptions;
}) =>
  Layer.succeed(WireMode, {
    present: (grants) =>
      Effect.sync((): WirePresentation => {
        const signatures = grants
          .map((grant) => renderSignature(grant, flavor.wrapReturn))
          .join("\n\n");
        const timeout = flavor.options?.timeout ?? "120 seconds";
        return {
          tools: [compileEvalTool(flavor.teach(signatures))],
          handlers: {
            eval: (input: { code: string }) =>
              flavor.evaluate(input.code, grants).pipe(
                Effect.timeoutOrElse({
                  duration: timeout,
                  orElse: () =>
                    Effect.fail(
                      `eval timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))} — split the work into smaller programs`,
                    ),
                }),
                Effect.map(renderResult),
              ) as Effect.Effect<string, any>,
          },
        };
      }),
  });
