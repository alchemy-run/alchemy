import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  manifestOf,
  renderDeclarations,
  type DeclarationForm,
  type DeclaredNamespace,
  type Manifest,
} from "./Declarations.ts";

/** Code mode could not start, or a script's sandbox failed. */
export class CodeModeError extends Data.TaggedError("CodeModeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

const load = <A>(run: () => Promise<A>): Effect.Effect<A, CodeModeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CodeModeError({ message: messageOf(cause), cause }),
  });

/**
 * Where code mode programs run: a deterministic JavaScript sandbox whose
 * only way out is the tools it is handed. Built when an instance first
 * opens its harness.
 */
export class Eval extends Context.Service<
  Eval,
  { readonly sandbox: Effect.Effect<CodemodeSandboxBase, CodeModeError, RuntimeContext> }
>()("AI.Eval") {}

const CodeModeTypeId = "~alchemy/AI/CodeMode" as const;

/** Tools a model reaches by writing a program. */
export interface CodeModeGroup<Tools extends ReadonlyArray<unknown> = ReadonlyArray<unknown>> {
  readonly [CodeModeTypeId]: true;
  readonly tools: Tools;
}

export const isCodeMode = (u: unknown): u is CodeModeGroup =>
  typeof u === "object" && u !== null && CodeModeTypeId in u;

/**
 * List tools a model reaches from a program instead of one call at a
 * time. The model writes JavaScript against a TypeScript declaration of
 * each tool, the program runs in a sandbox, and only what it returns
 * reaches the model.
 *
 * A tool outside the group is a direct call. A tool in both is offered
 * both ways. An `AI.McpServer` in the group gives every tool it lists,
 * under the server's name.
 *
 * Provide how programs are written and where they run:
 * `AI.CodeModeAsync` or `AI.CodeModeEffect`, over an `AI.Eval`.
 *
 * **Example:** Files and shell as direct calls, your tools from programs
 * ```typescript
 * const harness = yield* Pi.Harness({
 *   models: [Fast],
 *   tools: [AI.CodingTools, AI.CodeMode(Add, Withdraw)],
 * });
 * ```
 *
 * **Example:** Everything from programs
 * ```typescript
 * const harness = yield* Pi.Harness({
 *   models: [Fast],
 *   tools: [AI.CodeMode(AI.CodingTools, Add, Withdraw)],
 * });
 * ```
 */
export const CodeMode = <const Tools extends ReadonlyArray<unknown>>(
  ...tools: Tools
): CodeModeGroup<Tools> => ({ [CodeModeTypeId]: true, tools });

/** What a model is told, and what its script becomes, for one set of tools. */
export interface Program {
  /** The TypeScript declaration of `tools`. */
  readonly declarations: string;
  /** The script the sandbox runs, around the model's code. */
  readonly wrap: (code: string) => string;
}

/** How programs are written. */
export interface Convention {
  readonly form: DeclarationForm;
  /** How to write a program, for the code mode tool's description. */
  readonly intro: string;
  /** The line above the declarations. */
  readonly heading: string;
  /** The declarations of these tools, and the wrapper that gives a script the same names. */
  readonly program: (tools: Omit<DeclaredNamespace, "name">) => Program;
}

/**
 * How a model writes code mode programs, and where they run. Provided by
 * `AI.CodeModeAsync` or `AI.CodeModeEffect` over an `AI.Eval`, or whole
 * by a harness's own code mode (`OpenCode.CodeModeNative`).
 */
export class CodeModeConvention extends Context.Service<
  CodeModeConvention,
  | {
      readonly kind: "shared";
      readonly convention: Effect.Effect<Convention, CodeModeError>;
      readonly sandbox: Effect.Effect<CodemodeSandboxBase, CodeModeError, RuntimeContext>;
    }
  | {
      /** The harness's own code mode, which decides how programs are written and run. */
      readonly kind: "native";
      readonly engine: string;
    }
>()("AI.CodeModeConvention") {}

/**
 * Builds `tools` as the declarations describe it: each tool by its path,
 * each failure class beside the tools that declare it. A declared failure
 * reaches the script as an Error whose message is its fields as JSON.
 */
const PRELUDE = `function __alchemyFields(error) {
  if (error === null || typeof error !== "object" || typeof error.message !== "string") return undefined;
  let fields;
  try { fields = JSON.parse(error.message); } catch { return undefined; }
  if (fields === null || typeof fields !== "object" || typeof fields._tag !== "string") return undefined;
  return fields;
}
function __alchemyTools(raw, manifest, lift, makeClass) {
  const root = {};
  const at = (path) => path.reduce((scope, name) => (scope[name] === undefined ? (scope[name] = {}) : scope[name]), root);
  for (const entry of manifest.classes) at(entry.path)[entry.name] = makeClass(entry.tag, entry.name);
  for (const tool of manifest.tools) {
    const scope = at(tool.path.slice(0, -1));
    scope[tool.path[tool.path.length - 1]] = lift(
      (...args) => raw[tool.callAs](...args),
      (error) => {
        const fields = __alchemyFields(error);
        if (fields === undefined) return undefined;
        const declared = scope[tool.failures[fields._tag]];
        if (declared !== undefined) return new declared(fields);
        return Object.assign(new Error(typeof fields.message === "string" ? fields.message : error.message), { name: fields._tag }, fields);
      },
    );
  }
  const freeze = (scope) => {
    for (const value of Object.values(scope)) if (value !== null && typeof value === "object") freeze(value);
    return Object.freeze(scope);
  };
  return freeze(root);
}`;

const RULES = [
  "- `tools` is declared in the code mode section of the system prompt: call a tool by the path its declaration has (`tools.add`, `tools.github.get_issue`).",
  "- The script survives a restart where its harness keeps a journal: it resumes without running finished calls again.",
];

const asyncConvention: Convention = {
  form: "async",
  intro: [
    "Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a sandbox: top-level `await` and `return` work. No Node, file system, network, or timers.",
    "- `await tools.<name>({ ...args })` resolves to the value its declaration says. A failure it declares with `@throws` rejects with an instance of that class, which carries the failure's `_tag` and fields: check `error instanceof tools.<Class>` or `error._tag`. Any other rejection is a defect. Calls still running when the script ends are cancelled.",
    ...RULES,
  ].join("\n"),
  heading: "Tools scripts can call (`await tools.<name>(args)`):",
  program: (tools) => {
    const manifest = manifestOf(tools);
    return {
      declarations: renderDeclarations("async", tools),
      wrap: (code) => wrapAsync(code, manifest),
    };
  },
};

const wrapAsync = (code: string, manifest: Manifest) => `${PRELUDE}
return await (async (tools) => {
${code}
})(__alchemyTools(tools, ${JSON.stringify(manifest)},
  (call, failure) => (...args) => call(...args).catch((error) => { throw failure(error) ?? error; }),
  (tag, name) => {
    const declared = class extends Error {
      constructor(fields) {
        super(typeof fields.message === "string" ? fields.message : tag);
        Object.assign(this, fields);
        this._tag = tag;
        this.name = name;
      }
    };
    Object.defineProperty(declared, "name", { value: name });
    return declared;
  },
));`;

const effectConvention = (names: ReadonlyArray<string>, runtime: string): Convention => ({
  form: "effect",
  intro: [
    "Run an Effect program that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as the body of `Effect.gen(function* () { ... })` in a sandbox: use `yield*` (never `await`) and `return` the result. No Node, file system, network, or timers: `Effect.sleep`, `Effect.timeout`, and timed schedules fail.",
    "- `tools.<name>({ ...args })` is an `Effect<A, E>` that requires nothing: `A` is the value its declaration says, `E` the failures it declares, each a `Data.TaggedError` class. Handle them with `Effect.catchTag`. Any other failure is a defect. Use `Effect.all(effects, { concurrency: 5 })` to call tools at once.",
    `- In scope: ${names.map((name) => `\`${name}\``).join(", ")} (effect's modules; \`Arr\`, \`Str\`, \`Num\` are effect/Array, effect/String, effect/Number).`,
    ...RULES,
  ].join("\n"),
  heading: "Tools scripts can call (`yield* tools.<name>(args)`):",
  program: (tools) => {
    const manifest = manifestOf(tools);
    return {
      declarations: renderDeclarations("effect", tools),
      wrap: (code) => `${PRELUDE}
// The sandbox has no timers. Effect yields with a zero delay, which a
// microtask keeps deterministic; any real delay is a defect that says why.
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
}))(__alchemyTools(tools, ${JSON.stringify(manifest)},
  (call, failure) => (...args) =>
    Effect.flatMap(
      Effect.promise(() => call(...args).then((value) => ({ value }), (error) => ({ error }))),
      (result) => {
        if (!("error" in result)) return Effect.succeed(result.value);
        const failed = failure(result.error);
        return failed === undefined ? Effect.die(result.error) : Effect.fail(failed);
      },
    ),
  (tag, name) => {
    const declared = class extends Data.TaggedError(tag) {
      constructor(fields) {
        const { _tag, ...rest } = fields;
        super(rest);
      }
    };
    Object.defineProperty(declared, "name", { value: name });
    return declared;
  },
)));
if (Exit.isSuccess(__alchemyExit)) return __alchemyExit.value;
throw new Error(Cause.pretty(__alchemyExit.cause));`,
    };
  },
});

/**
 * Programs written with promises: `await tools.<name>(args)`. A tool's
 * declared failures are classes that extend `Error`, named in its
 * `@throws` tags.
 *
 * **Example:** Async programs on the Durable Object's thread
 * ```typescript
 * const CodeModeLive = AI.CodeModeAsync.pipe(Layer.provide(AICloudflare.EvalInline()));
 * ```
 *
 * @layer
 * @provides AI.CodeModeConvention
 */
export const CodeModeAsync: Layer.Layer<CodeModeConvention, never, Eval> = Layer.effect(
  CodeModeConvention,
  Effect.map(Effect.service(Eval), (evaluator) => ({
    kind: "shared" as const,
    convention: Effect.succeed(asyncConvention),
    sandbox: evaluator.sandbox,
  })),
);

/**
 * Programs written as Effects: a script is the body of
 * `Effect.gen(function* () { … })`, and `tools.<name>(args)` is an
 * `Effect<A, E>` that requires nothing, whose `E` is the tool's declared
 * failures as `Data.TaggedError` classes. effect's modules are in scope
 * (`Effect`, `Data`, `Option`, `Arr`, `pipe`, …).
 *
 * Effect runs inside the sandbox with the script, so this pairs with every
 * `AI.Eval`. The sandbox has no timers: `Effect.sleep` and timed schedules
 * fail.
 *
 * **Example:** Effect programs in an isolate of their own
 * ```typescript
 * const CodeModeLive = AI.CodeModeEffect.pipe(Layer.provide(AICloudflare.EvalWorkerLoader()));
 * ```
 *
 * @layer
 * @provides AI.CodeModeConvention
 */
export const CodeModeEffect: Layer.Layer<CodeModeConvention, never, Eval> = Layer.effect(
  CodeModeConvention,
  Effect.map(Effect.service(Eval), (evaluator) => ({
    kind: "shared" as const,
    // The runtime is ~190KB of source: load it only where it is used.
    convention: load(() => import("./internal/codemode-effect.generated.ts")).pipe(
      Effect.map(({ EFFECT_NAMES, EFFECT_RUNTIME }) =>
        effectConvention(EFFECT_NAMES, EFFECT_RUNTIME),
      ),
    ),
    sandbox: evaluator.sandbox,
  })),
);

/**
 * Run programs in QuickJS on a worker thread of this process. Needs Node
 * or Bun (a Fly Machine, an ECS task, a container).
 *
 * @layer
 * @provides AI.Eval
 */
export const EvalQuickJS = (
  options: { readonly timeoutMs?: number; readonly memoryLimitBytes?: number } = {},
): Layer.Layer<Eval> =>
  Layer.succeed(Eval, {
    sandbox: load(async () => {
      const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
      return new CodemodeSandbox(options);
    }),
  });

/** The sandbox, running each script wrapped by `wrap`. */
export const wrapScripts = (
  sandbox: CodemodeSandboxBase,
  wrap: (code: string) => string,
): CodemodeSandboxBase =>
  new Proxy(sandbox, {
    get: (target, property) => {
      if (property === "start") {
        return (code: string, options: Parameters<CodemodeSandboxBase["start"]>[1]) =>
          target.start(wrap(code), options);
      }
      if (property === "execute") {
        return (code: string, options: Parameters<CodemodeSandboxBase["execute"]>[1]) =>
          target.execute(wrap(code), options);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
