import type { CodemodeJsonSchema, CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import type {
  Extension as PiExtension,
  PromptSection,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PiError } from "./Errors.ts";
import type { AnyExtension } from "./Extension.ts";
import { fromPi } from "./internal/promise.ts";
import { FAILURE_SCHEMA } from "./Tool.ts";

const ExtensionTypeId = "~alchemy/Pi/Extension" as const;

/**
 * Where code-mode scripts run: a deterministic JavaScript sandbox, so a
 * script cut off by a crash replays from its journal of tool results.
 * Built when an instance first opens its harness.
 */
export class Eval extends Context.Service<
  Eval,
  { readonly sandbox: Effect.Effect<CodemodeSandboxBase, PiError, RuntimeContext> }
>()("Pi.Eval") {}

/**
 * How the model writes code-mode programs: the tool it is offered and the
 * declarations it programs against. Built over an {@link Eval}.
 */
export class CodeModeConvention extends Context.Service<
  CodeModeConvention,
  { readonly extension: Effect.Effect<PiExtension, PiError, RuntimeContext> }
>()("Pi.CodeModeConvention") {}

export interface CodeModeExtension extends AnyExtension {
  readonly [ExtensionTypeId]: "codemode";
  readonly "~requires": CodeModeConvention;
}

/**
 * Code mode: the model writes a JavaScript program that calls the
 * conversation's tools (`await tools.read({ path })`), and only the
 * program's output reaches it. Select it like any extension; provide a
 * convention (`Pi.CodeModeAsync`, `Pi.CodeModeEffect`) over a runtime
 * (`Pi.EvalQuickJS`, `PiCloudflare.EvalInline`, `PiCloudflare.EvalWorkerLoader`).
 */
export const CodeMode: CodeModeExtension = {
  [ExtensionTypeId]: "codemode",
  key: "Pi.CodeMode",
  extensionName: "codemode",
  spec: {},
  impl: undefined,
  hasImpl: false,
  "~requires": undefined as never,
};

/** The name of the tool code mode adds. */
export const CODEMODE_TOOL = "codemode";

/** How a convention presents tools to the model and wraps its scripts. */
interface Convention {
  /** The first paragraph of the `codemode` tool's description. */
  readonly intro: string;
  /** The line above the tool declarations in the `codemode` prompt section. */
  readonly heading: string;
  /** One tool's declaration, from its success type and its failure type, if any. */
  readonly signature: (signature: Signature) => string;
  /** The script the VM runs, around the model's code. */
  readonly wrap: (code: string) => string;
}

interface Signature {
  /** `add(args: { a: number; b: number; })`: the member up to its return type. */
  readonly call: string;
  readonly success: string;
  readonly failure: string | undefined;
}

const OPTIONS_LINE =
  '- Optional first line: `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`';
const RESTART_LINE =
  "- The script survives a restart: it resumes where it was, without running finished calls again.";

/**
 * Rebuilds a declared failure from the error Pi hands the script: its
 * message is the failure's encoded fields, `_tag` among them.
 */
const FAILURE_PRELUDE = `function __alchemyFailure(error) {
  if (error === null || typeof error !== "object" || typeof error.message !== "string") return undefined;
  let fields;
  try { fields = JSON.parse(error.message); } catch { return undefined; }
  if (fields === null || typeof fields !== "object" || typeof fields._tag !== "string") return undefined;
  return Object.assign(new Error(typeof fields.message === "string" ? fields.message : error.message), { name: fields._tag }, fields);
}
function __alchemyTools(raw, lift) {
  const lifted = Object.create(null);
  for (const name of Object.getOwnPropertyNames(raw)) lifted[name] = lift((...args) => raw[name](...args));
  return Object.freeze(lifted);
}`;

/**
 * Pi's own convention: `await tools.<name>(args)`, with TypeScript
 * declarations of every tool, typed by its `success` schema. A tool's
 * declared failure rejects with an `Error` that carries its `_tag` and
 * fields.
 *
 * @layer
 * @provides Pi.CodeModeConvention
 */
export const CodeModeAsync: Layer.Layer<CodeModeConvention, never, Eval> = Layer.effect(
  CodeModeConvention,
  Effect.map(Effect.service(Eval), (evaluator) => ({
    extension: makeExtension(evaluator, Effect.succeed(asyncConvention)),
  })),
);

const asyncConvention: Convention = {
  intro: [
    "Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level `await` and `return` work. No Node, file system, network, or timers.",
    "- `await tools.<name>({ ...args })` resolves to the value its declaration says (a string when it names none). A declared failure (`rejects with` in the `codemode` section) rejects with an Error carrying the failure's `_tag` and fields: check `error._tag`. Any other rejection is a defect. Calls still running when the script ends are cancelled.",
    RESTART_LINE,
    OPTIONS_LINE,
  ].join("\n"),
  heading: "Tools scripts can call (`await tools.<name>(args)`):",
  signature: ({ call, success, failure }) =>
    [
      `declare const tools: { ${call}: Promise<${success}>; };`,
      ...(failure === undefined ? [] : [`// rejects with ${failure}`]),
    ].join("\n"),
  wrap: (code) => `${FAILURE_PRELUDE}
return await (async (tools) => {
${code}
})(__alchemyTools(tools, (call) => (...args) => call(...args).catch((error) => {
  throw __alchemyFailure(error) ?? error;
})));`,
};

/**
 * The Effect convention: a script is the body of `Effect.gen(function* () { … })`,
 * `tools.<name>(args)` is an `Effect<A, E>` whose `E` is the tool's declared
 * failure, and effect's modules are in scope (`Effect`, `Data`, `Option`,
 * `Arr`, `pipe`, …). Effect runs inside the VM, so this pairs with every
 * runtime, and scripts replay after a crash like async ones. The VM has no
 * timers: `Effect.sleep` and timed schedules fail.
 *
 * **Example:** Effect code mode in an isolate
 * ```typescript
 * const CodeModeLive = Pi.CodeModeEffect.pipe(Layer.provide(PiCloudflare.EvalWorkerLoader()));
 * ```
 *
 * @layer
 * @provides Pi.CodeModeConvention
 */
export const CodeModeEffect: Layer.Layer<CodeModeConvention, never, Eval> = Layer.effect(
  CodeModeConvention,
  Effect.map(Effect.service(Eval), (evaluator) => ({
    extension: makeExtension(
      evaluator,
      // The runtime is ~190KB of source: load it only where it is used.
      fromPi(() => import("./internal/codemode-effect.generated.ts")).pipe(
        Effect.map(({ EFFECT_NAMES, EFFECT_RUNTIME }) =>
          effectConvention(EFFECT_NAMES, EFFECT_RUNTIME),
        ),
      ),
    ),
  })),
);

const effectConvention = (names: ReadonlyArray<string>, runtime: string): Convention => ({
  intro: [
    "Run an Effect program that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as the body of `Effect.gen(function* () { ... })` in a QuickJS sandbox: use `yield*` (never `await`) and `return` the result. No Node, file system, network, or timers: `Effect.sleep`, `Effect.timeout`, and timed schedules fail.",
    "- `tools.<name>({ ...args })` is an `Effect<A, E>`: `A` is the value its declaration says (a string when it names none), `E` the tool's declared failures, tagged by `_tag`; handle them with `Effect.catchTag`. Any other failure is a defect. Use `Effect.all(effects, { concurrency: 5 })` to call tools at once.",
    `- In scope: ${names.map((name) => `\`${name}\``).join(", ")} (effect's modules; \`Arr\`, \`Str\`, \`Num\` are effect/Array, effect/String, effect/Number). The promise globals below run with \`yield* Effect.promise(() => describeTool(name))\`.`,
    RESTART_LINE,
    OPTIONS_LINE,
  ].join("\n"),
  heading: "Tools scripts can call (`yield* tools.<name>(args)`):",
  signature: ({ call, success, failure }) =>
    `declare const tools: { ${call}: Effect<${success}, ${failure ?? "never"}>; };`,
  wrap: (code) => `${FAILURE_PRELUDE}
// The VM has no timers. Effect yields with a zero delay, which a microtask
// keeps deterministic; any real delay is a defect that says why.
const setTimeout = (callback, delay) => {
  if (delay > 0) throw new Error("Code mode scripts have no timers: Effect.sleep, Effect.timeout and timed schedules are unavailable.");
  const timer = { cancelled: false };
  Promise.resolve().then(() => { if (!timer.cancelled) callback(); });
  return timer;
};
const clearTimeout = (timer) => { if (timer) timer.cancelled = true; };
${runtime}
const { ${names.join(", ")} } = __alchemyEffect;
const __alchemyExit = await Effect.runPromiseExit(((tools) => Effect.gen(function* () {
${code}
}))(__alchemyTools(tools, (call) => (...args) =>
  Effect.flatMap(
    Effect.promise(() => call(...args).then((value) => ({ value }), (error) => ({ error }))),
    (result) => {
      if (!("error" in result)) return Effect.succeed(result.value);
      const failure = __alchemyFailure(result.error);
      return failure === undefined ? Effect.die(result.error) : Effect.fail(failure);
    },
  ))));
if (Exit.isSuccess(__alchemyExit)) return __alchemyExit.value;
throw new Error(Cause.pretty(__alchemyExit.cause));`,
});

/**
 * Pi's code mode extension, presented by `convention`: its `codemode` tool
 * describes the convention, its prompt section declares each tool with its
 * failures, and the sandbox runs each script wrapped by the convention.
 */
const makeExtension = (
  evaluator: Eval["Service"],
  convention: Effect.Effect<Convention, PiError, RuntimeContext>,
): Effect.Effect<PiExtension, PiError, RuntimeContext> =>
  Effect.gen(function* () {
    const sandbox = yield* evaluator.sandbox;
    const presented = yield* convention;
    const [{ createCodemodeExtension, DEFAULT_CODEMODE_INLINE_BUDGET }, declarations] =
      yield* fromPi(() =>
        Promise.all([
          import("@earendil-works/pi-durable/codemode"),
          import("@earendil-works/pi-codemode/declarations"),
        ]),
      );
    const extension = createCodemodeExtension({
      sandbox: wrapScripts(sandbox, presented.wrap),
    }) as PiExtension;

    const declare = (tool: ToolRegistration): string => {
      const output = (tool.structuredOutputSchema ?? { type: "string" }) as CodemodeJsonSchema;
      const member = declarations.renderToolSignature({
        name: tool.name,
        inputSchema: tool.parameters as CodemodeJsonSchema,
        outputSchema: output,
      });
      const success = declarations.renderToolOutputType(output);
      const failureSchema = (tool as { [FAILURE_SCHEMA]?: CodemodeJsonSchema })[FAILURE_SCHEMA];
      const call = member.slice(0, member.lastIndexOf(`: Promise<${success}>;`));
      return presented.signature({
        call,
        success,
        failure:
          failureSchema === undefined
            ? undefined
            : declarations.schemaToType(closed(failureSchema)),
      });
    };

    const section: PromptSection = {
      key: "codemode",
      render: ({ agent }) => {
        const tools = agent.callable.filter(
          (tool) => !tool.name.startsWith("pi.codemode.") && tool.deferred !== true,
        );
        if (tools.length === 0) return undefined;
        let budget = DEFAULT_CODEMODE_INLINE_BUDGET * 4;
        const shown: string[] = [];
        for (const tool of tools) {
          const id = declarations.toCodemodeIdentifier(tool.name);
          const heading = id === tool.name ? `### \`${id}\`` : `### \`${id}\` (\`${tool.name}\`)`;
          const entry = `${heading}\n${tool.description.trim()}\n\n\`\`\`ts\n${declare(tool)}\n\`\`\``;
          if (entry.length > budget) continue;
          budget -= entry.length;
          shown.push(entry);
        }
        return [
          presented.heading,
          ...(shown.length < tools.length
            ? ["Some tools are not listed: find them with `searchTools()`."]
            : []),
          ...shown,
        ].join("\n\n");
      },
    };

    return {
      ...extension,
      tools: (extension.tools ?? []).map((tool) =>
        tool.name === CODEMODE_TOOL
          ? {
              ...tool,
              // Keep Pi's globals; replace how scripts are written.
              description: [presented.intro, ...tool.description.split("\n\n").slice(1)].join(
                "\n\n",
              ),
            }
          : tool,
      ),
      sections: [section],
    };
  });

/** The sandbox, running each script wrapped by `wrap`. */
const wrapScripts = (
  sandbox: CodemodeSandboxBase,
  wrap: (code: string) => string,
): CodemodeSandboxBase =>
  new Proxy(sandbox, {
    get: (target, property) => {
      if (property === "start") {
        return (code: string, options: Parameters<CodemodeSandboxBase["start"]>[1]) =>
          target.start(wrap(code), options);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** A failure schema without `additionalProperties`, which renders as `[key: string]: unknown`. */
const closed = (schema: CodemodeJsonSchema): CodemodeJsonSchema =>
  JSON.parse(JSON.stringify(schema), (key, value) =>
    key === "additionalProperties" ? undefined : value,
  ) as CodemodeJsonSchema;

/**
 * Run scripts in QuickJS on a worker thread of this process. Needs Node
 * or Bun (a Fly Machine, an ECS task, a container).
 *
 * @layer
 * @provides Pi.Eval
 */
export const EvalQuickJS = (
  options: { readonly timeoutMs?: number; readonly memoryLimitBytes?: number } = {},
): Layer.Layer<Eval> =>
  Layer.succeed(Eval, {
    sandbox: fromPi(async () => {
      const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
      return new CodemodeSandbox(options);
    }),
  });

export const isCodeMode = (extension: AnyExtension): extension is CodeModeExtension =>
  extension[ExtensionTypeId] === "codemode";

export { PiError };
