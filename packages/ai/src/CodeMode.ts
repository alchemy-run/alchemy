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

/** What one program produced: its value, or why it failed, and what it printed. */
export type Evaluation =
  | { readonly ok: true; readonly value: unknown; readonly output: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string; readonly output: ReadonlyArray<string> };

/** The tools a script calls, by the name it calls them. A rejection is how a call fails. */
export type ScriptTools = Readonly<Record<string, (args: unknown) => Promise<unknown>>>;

/** A place code mode programs run. */
export interface Evaluator {
  /**
   * Run a script: the body of an async function over `tools`, `console`
   * and `text`. A script that throws is an `Evaluation` that is not `ok`.
   */
  readonly run: (
    script: string,
    tools: ScriptTools,
  ) => Effect.Effect<Evaluation, CodeModeError, RuntimeContext>;
  /**
   * Pi's deterministic VM, where this evaluator is one. Pi runs programs in
   * it through its journal, so a program resumes after a restart.
   */
  readonly vm?: Effect.Effect<CodemodeSandboxBase, CodeModeError, RuntimeContext>;
}

/**
 * Where code mode programs run: a JavaScript sandbox whose only way out is
 * the tools it is handed. Each Layer is one place: an isolate of its own
 * (`AICloudflare.EvalWorkerLoader`), or a QuickJS VM
 * (`AI.EvalQuickJS`, `AICloudflare.EvalQuickJS`).
 */
export class Eval extends Context.Service<Eval, Evaluator>()("AI.Eval") {}

/** An evaluator over Pi's QuickJS sandbox: a VM per script, closed when it ends. */
export const quickJSEvaluator = (
  sandbox: Effect.Effect<CodemodeSandboxBase, CodeModeError, RuntimeContext>,
): Evaluator => ({
  vm: sandbox,
  run: (script, tools) =>
    Effect.gen(function* () {
      const vm = yield* sandbox;
      for (const [name, execute] of Object.entries(tools)) vm.registerTool({ name, execute });
      const result = yield* load(() => vm.execute(script)).pipe(
        Effect.ensuring(Effect.promise(() => vm.close().catch(() => undefined))),
      );
      const output = result.output.flatMap((item) => (item.type === "text" ? [item.text] : []));
      return result.ok
        ? { ok: true as const, value: result.value, output }
        : { ok: false as const, message: result.error.message, output };
    }),
});

/** An evaluation as a tool result: what the program printed, then its value or its error. */
export const renderEvaluation = (
  evaluation: Evaluation,
): { readonly text: string; readonly isError: boolean } =>
  evaluation.ok
    ? {
        text: [
          ...evaluation.output,
          ...(evaluation.value === undefined ? [] : [JSON.stringify(evaluation.value)]),
        ].join("\n"),
        isError: false,
      }
    : { text: [...evaluation.output, evaluation.message].join("\n"), isError: true };

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
      readonly evaluator: Evaluator;
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

/** A fence a model put around its program, which the input should not have. */
const FENCE = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/;
const IMPORT = /^[ \t]*import\s+(?:([^;'"]*?)\s+from\s*)?(["'])([^"'\n]+)\2[ \t]*;?/gm;
const EXPORT_DEFAULT = /^([ \t]*)export\s+default\s+/m;
const EXPORT = /^([ \t]*)export\s+(?=(?:const|let|var|function|async|class)\b)/gm;

/** `import` as the lookup a script can run: `a as b` becomes `a: b`. */
const importOf = (clause: string | undefined, specifier: string): string => {
  const from = `__alchemyImport(${JSON.stringify(specifier)})`;
  if (clause === undefined) return `${from};`;
  const named = /\{([^}]*)\}/.exec(clause);
  const namespace = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  const whole = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
  return [
    ...(whole ? [`const ${whole[1]} = ${from};`] : []),
    ...(namespace ? [`const ${namespace[1]} = ${from};`] : []),
    ...(named
      ? [`const {${named[1]!.replace(/\s+as\s+/g, ": ").replace(/\s+/g, " ")}} = ${from};`]
      : []),
  ].join(" ");
};

/**
 * A program as the body of a function. A program written as a module
 * returns its default export, its imports become lookups, and its other
 * exports plain declarations; any other program is already a body.
 *
 * This matches text, not syntax: a line of a template literal that starts
 * with `import` or `export` is rewritten too.
 */
export const programBody = (
  source: string,
): { readonly body: string; readonly module: boolean } => {
  const code = source
    .replace(FENCE, "$1")
    .replace(IMPORT, (_line, clause, _quote, specifier) => importOf(clause, specifier));
  if (!EXPORT_DEFAULT.test(code)) return { body: code, module: false };
  return {
    body: `${code.replace(EXPORT_DEFAULT, "$1const __alchemyDefault = ").replace(EXPORT, "$1")}\nreturn __alchemyDefault;`,
    module: true,
  };
};

const TOOLS_RULE =
  "- `tools` is declared in the code mode section of the system prompt: call a tool by the path its declaration has (`tools.add`, `tools.github.get_issue`).";

const asyncConvention: Convention = {
  form: "async",
  intro: [
    "Run a JavaScript program that calls other tools. The input is the program's source, with no code fence around it: an ES module whose default export is the result. Top-level `await` works. It runs in a sandbox: no Node, file system, network, timers, or modules to import.",
    "```js\nconst result = await tools.<name>({ ...args });\nexport default result;\n```",
    [
      "- A default export that is a function is called, and a promise is awaited. The body of an async function that ends in `return` works too.",
      "- `await tools.<name>({ ...args })` resolves to the value its declaration says. A failure it declares with `@throws` rejects with an instance of that class, which carries the failure's `_tag` and fields: check `error instanceof tools.<Class>` or `error._tag`. Any other rejection is a defect.",
      "- Await every call whose result matters: calls still running when the program ends are cancelled. Run independent calls at once with `Promise.all`.",
      TOOLS_RULE,
    ].join("\n"),
  ].join("\n\n"),
  heading: "Tools scripts can call (`await tools.<name>(args)`):",
  program: (tools) => {
    const manifest = manifestOf(tools);
    return {
      declarations: renderDeclarations("async", tools),
      wrap: (code) => wrapAsync(programBody(code).body, manifest),
    };
  },
};

const wrapAsync = (body: string, manifest: Manifest) => `${PRELUDE}
const __alchemyImport = (name) => {
  throw new Error("Programs cannot import " + JSON.stringify(name) + ": everything a program can use is in scope.");
};
const __alchemyResult = await (async (tools) => {
${body}
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
));
return typeof __alchemyResult === "function" ? await __alchemyResult() : __alchemyResult;`;

/** A program that runs its own Effect instead of exporting it. */
const RUNS_ITSELF = /\bEffect\s*\.\s*run(?:Promise|PromiseExit|Fork|Sync)\b/;

const effectConvention = (names: ReadonlyArray<string>, runtime: string): Convention => ({
  form: "effect",
  intro: [
    "Run an Effect program that calls other tools. The input is the program's source, with no code fence around it: an ES module whose default export is an Effect. The Effect is run, and what it succeeds with is the result. It runs in a sandbox: no Node, file system, network, or timers, so `Effect.sleep`, `Effect.timeout`, and timed schedules fail.",
    "```js\nexport default Effect.gen(function* () {\n  const result = yield* tools.<name>({ ...args });\n  return result;\n});\n```",
    [
      "- `tools.<name>({ ...args })` is an `Effect<A, E>` that requires nothing: `A` is the value its declaration says, `E` the failures it declares, each a `Data.TaggedError` class. Handle them with `Effect.catchTag`. Any other failure is a defect. Use `Effect.all(effects, { concurrency: 5 })` to call tools at once.",
      `- In scope: ${names.map((name) => `\`${name}\``).join(", ")} (effect's modules; \`Arr\`, \`Str\`, \`Num\` are effect/Array, effect/String, effect/Number). Importing them from \`effect\` works too; nothing else can be imported.`,
      "- The body of `Effect.gen(function* () { ... })` on its own, with `yield*` and `return`, works too.",
      TOOLS_RULE,
    ].join("\n"),
  ].join("\n\n"),
  heading: "Tools scripts can call (`yield* tools.<name>(args)`):",
  program: (tools) => {
    const manifest = manifestOf(tools);
    return {
      declarations: renderDeclarations("effect", tools),
      wrap: (code) => {
        const { body, module } = programBody(code);
        // A module, or a body that runs its Effect itself, is an async
        // function; any other body is the generator of `Effect.gen`.
        const program =
          module || RUNS_ITSELF.test(body)
            ? `await (async (tools) => {\n${body}\n})(__alchemyScope)`
            : `((tools) => Effect.gen(function* () {\n${body}\n}))(__alchemyScope)`;
        return `${PRELUDE}
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
const __alchemyRoot = { ...__alchemyEffect, Array: Arr, String: Str, Number: Num, Function: { pipe, flow, identity } };
const __alchemyImport = (name) => {
  if (name === "effect") return __alchemyRoot;
  const module = name.startsWith("effect/") ? __alchemyRoot[name.slice(7)] : undefined;
  if (module !== undefined) return module;
  throw new Error("Programs cannot import " + JSON.stringify(name) + ": only these effect modules exist here: ${names.join(", ")}.");
};
const __alchemyScope = __alchemyTools(tools, ${JSON.stringify(manifest)},
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
);
let __alchemyProgram = ${program};
if (typeof __alchemyProgram === "function") __alchemyProgram = await __alchemyProgram();
if (!Effect.isEffect(__alchemyProgram)) return __alchemyProgram;
const __alchemyExit = await Effect.runPromiseExit(__alchemyProgram);
if (Exit.isSuccess(__alchemyExit)) return __alchemyExit.value;
throw new Error(Cause.pretty(__alchemyExit.cause));`;
      },
    };
  },
});

/**
 * Programs written with promises: a module that calls
 * `await tools.<name>(args)` and exports its result as the default. A
 * tool's declared failures are classes that extend `Error`, named in its
 * `@throws` tags.
 *
 * **Example:** Async programs in an isolate of their own
 * ```typescript
 * const CodeModeLive = AI.CodeModeAsync.pipe(Layer.provide(AICloudflare.EvalWorkerLoader()));
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
    evaluator,
  })),
);

/**
 * Programs written as Effects: a module whose default export is an
 * Effect, which is run. `tools.<name>(args)` is an `Effect<A, E>` that
 * requires nothing, whose `E` is the tool's declared failures as
 * `Data.TaggedError` classes. effect's modules are in scope (`Effect`,
 * `Data`, `Option`, `Arr`, `pipe`, …), and a program may import them from
 * `effect`.
 *
 * Effect runs inside the sandbox with the program, so this pairs with
 * every `AI.Eval`. Programs have no timers: `Effect.sleep` and timed
 * schedules fail.
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
    evaluator,
  })),
);

/**
 * Run programs in a QuickJS VM on a worker thread of this process. Needs
 * Node or Bun (a Fly Machine, an ECS task, a container). The VM is
 * deterministic, so on Pi a program resumes after a restart.
 *
 * @layer
 * @provides AI.Eval
 */
export const EvalQuickJS = (
  options: { readonly timeoutMs?: number; readonly memoryLimitBytes?: number } = {},
): Layer.Layer<Eval> =>
  Layer.succeed(
    Eval,
    quickJSEvaluator(
      load(async () => {
        const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
        return new CodemodeSandbox(options);
      }),
    ),
  );

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
