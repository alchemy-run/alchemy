import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Eval, TOOLS_RAW_MODULE } from "./Eval.ts";

type Namespace = Record<string, unknown>;

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (
  require: (specifier: string) => Promise<Namespace>,
  exports: Namespace,
  console: unknown,
) => Promise<void>;

/**
 * Statement position: start of a line, or right after `;`/`{`/`}` — a
 * module may put several statements on one line. The leading whitespace
 * is matched inside the LOOKBEHIND so it is not consumed: indentation
 * and the newlines between statements survive the rewrite (line numbers
 * keep pointing at the model's own source).
 */
const AT = String.raw`(?<=(?:^|[;{}])\s*)`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
// exactly ONE capture group (the specifier) so composed rules number
// their own groups predictably — no backreference, since a quote
// mismatch like `"x'` is not worth a shifting group index
const FROM = String.raw`from\s*["']([^"']+)["']\s*;?`;
const statement = (pattern: string) => new RegExp(`${AT}${pattern}`, "gm");

/** `a, b as c` (import clause) → `a, b: c` (destructure pattern). */
const destructure = (names: string) => names.replaceAll(/\s+as\s+/g, ": ");

/** Parse an export clause (`a, b as c, d as default`) into pairs. */
const clause = (
  names: string,
): ReadonlyArray<{ readonly local: string; readonly exported: string }> =>
  names
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [local, exported = local] = entry.split(/\s+as\s+/);
      return { local: local!, exported: exported! };
    });

/**
 * Compile one ES module SOURCE into an async function: import and
 * export statements become `await __require(...)` lookups and
 * `__exports` assignments, so the module runs as a plain function with
 * its dependencies — including the tools namespace, as REAL closures —
 * passed in. Every statement form the conventions or a model can write:
 *
 * - `import * as X from "s"`        → `const X = await __require("s")`
 * - `import { a, b as c } from "s"` → `const { a, b: c } = await __require("s")`
 * - `import X from "s"`             → `const X = (await __require("s")).default`
 * - `import X, { a } from "s"`      → both of the above
 * - `import "s"`                    → `await __require("s")` (side effects)
 * - `export * from "s"`             → `Object.assign(__exports, …)`
 * - `export { a, b as c } from "s"` → per-name assignment off the namespace
 * - `export { a, b as c }`          → `__exports.a = a; __exports.c = b;`
 * - `export default …`              → `__exports.default = …`
 * - `export const/let/var x = …`    → the declaration, plus an export
 * - `export [async] function f`     → the declaration, plus an export
 * - `export class C`                → the declaration, plus an export
 *
 * DECLARATION exports keep their local binding (the declaration is left
 * in place and the export is appended at the end of the module), so a
 * module can use what it exports — rewriting `export const a = 1` to
 * `__exports.a = 1` would leave `a` undefined for the rest of the body.
 *
 * Known limitations, both lexical: rewriting is regex-based at
 * statement position, so an import/export-shaped LINE inside a template
 * literal is rewritten (mid-line strings are safe); and only the FIRST
 * declarator of a multi-declarator `export const a = 1, b = 2` is
 * exported.
 */
const compileModule = (source: string) => {
  /** Declaration exports, assigned after the body has run. */
  const exported: Array<string> = [];
  let reexports = 0;

  const body = source
    .replaceAll(
      statement(String.raw`import\s*\*\s*as\s+(${NAME})\s+${FROM}`),
      (_match, name: string, specifier: string) =>
        `const ${name} = await __require(${JSON.stringify(specifier)});`,
    )
    .replaceAll(
      statement(String.raw`import\s+(${NAME})\s*,\s*\{([^}]*)\}\s*${FROM}`),
      (_match, name: string, names: string, specifier: string) =>
        `const ${name} = (await __require(${JSON.stringify(specifier)})).default; const {${destructure(names)}} = await __require(${JSON.stringify(specifier)});`,
    )
    .replaceAll(
      statement(String.raw`import\s*\{([^}]*)\}\s*${FROM}`),
      (_match, names: string, specifier: string) =>
        `const {${destructure(names)}} = await __require(${JSON.stringify(specifier)});`,
    )
    .replaceAll(
      statement(String.raw`import\s+(${NAME})\s+${FROM}`),
      (_match, name: string, specifier: string) =>
        `const ${name} = (await __require(${JSON.stringify(specifier)})).default;`,
    )
    .replaceAll(
      statement(String.raw`import\s*["']([^"']+)["']\s*;?`),
      (_match, specifier: string) =>
        `await __require(${JSON.stringify(specifier)});`,
    )
    .replaceAll(
      statement(String.raw`export\s*\*\s*${FROM}`),
      (_match, specifier: string) =>
        `Object.assign(__exports, await __require(${JSON.stringify(specifier)}));`,
    )
    // `export { … } from "s"` — bind the namespace once, then assign
    .replaceAll(
      statement(String.raw`export\s*\{([^}]*)\}\s*${FROM}`),
      (_match, names: string, specifier: string) => {
        const namespace = `__reexport${reexports++}`;
        return `const ${namespace} = await __require(${JSON.stringify(specifier)}); ${clause(
          names,
        )
          .map(
            (entry) =>
              `__exports.${entry.exported} = ${namespace}.${entry.local};`,
          )
          .join(" ")}`;
      },
    )
    // `export { … }` — local bindings
    .replaceAll(
      statement(String.raw`export\s*\{([^}]*)\}\s*;?`),
      (_match, names: string) =>
        clause(names)
          .map((entry) => `__exports.${entry.exported} = ${entry.local};`)
          .join(" "),
    )
    .replaceAll(
      statement(String.raw`export\s+default\s+`),
      "__exports.default = ",
    )
    .replaceAll(
      statement(String.raw`export\s+(const|let|var)\s+(${NAME})`),
      (_match, kind: string, name: string) => {
        exported.push(name);
        return `${kind} ${name}`;
      },
    )
    .replaceAll(
      statement(String.raw`export\s+(async\s+)?function(\s*\*)?\s+(${NAME})`),
      (_match, asyncKeyword = "", star = "", name: string) => {
        exported.push(name);
        return `${asyncKeyword}function${star} ${name}`;
      },
    )
    .replaceAll(
      statement(String.raw`export\s+class\s+(${NAME})`),
      (_match, name: string) => {
        exported.push(name);
        return `class ${name}`;
      },
    );

  return new AsyncFunction(
    "__require",
    "__exports",
    "console",
    exported.length === 0
      ? body
      : `${body}\n${exported.map((name) => `__exports.${name} = ${name};`).join("\n")}`,
  );
};

/**
 * The IN-PROCESS {@link Eval}: each module of the graph compiles to an
 * async function (see {@link compileModule}) and the graph links
 * through a memoized `__require` — relative specifiers resolve to
 * sibling modules, the reserved `"tools.raw.js"` resolves DIRECTLY to
 * the granted handlers as closures (a rejected call carries the tool's
 * failure value, `_tag` intact, so the effect convention's `catchTag`
 * works), and bare specifiers (`effect/*`) are ordinary dynamic
 * imports resolved by the host runtime. `console` is a parameter, so
 * captured logs never touch the global.
 *
 * Fine for a local org; NOT an isolation boundary — the program
 * shares the driver's process. `Cloudflare.AI.EvalWorkerLoader` is
 * the isolated substrate behind the same contract.
 */
export const EvalFunction: Layer.Layer<Eval> = Layer.succeed(Eval, {
  run: ({ modules, main, tools, timeout }) =>
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const record =
        (level: string) =>
        (...args: Array<unknown>) =>
          logs.push(
            `${level === "log" ? "" : `[${level}] `}${args.map(format).join(" ")}`,
          );
      const capturedConsole = {
        log: record("log"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
        debug: record("debug"),
      };

      // the reserved tools module IS the granted handlers, as closures
      const toolsNamespace: Namespace = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          (input: unknown) =>
            Effect.runPromise(tool.call(input) as Effect.Effect<unknown>),
        ]),
      );

      const namespaces = new Map<string, Promise<Namespace>>();
      const require = (specifier: string): Promise<Namespace> => {
        const key = specifier.startsWith("./") ? specifier.slice(2) : specifier;
        if (key === TOOLS_RAW_MODULE) return Promise.resolve(toolsNamespace);
        const name =
          modules[key] !== undefined
            ? key
            : modules[`${key}.js`] !== undefined
              ? `${key}.js`
              : undefined;
        // not in the graph: an ordinary dynamic import (effect/*, …)
        if (name === undefined) return import(specifier);
        const linked = namespaces.get(name);
        if (linked !== undefined) return linked;
        const instantiated = (async () => {
          const exports: Namespace = {};
          await compileModule(modules[name]!)(
            require,
            exports,
            capturedConsole,
          );
          return exports;
        })();
        namespaces.set(name, instantiated);
        return instantiated;
      };

      const output = yield* Effect.tryPromise({
        try: async () => {
          const thunk = (await require(main)).default;
          if (typeof thunk !== "function") {
            throw new Error(
              "the program has no default export — `export default` your program",
            );
          }
          return await (thunk as () => Promise<unknown>)();
        },
        // a SyntaxError is a broken module, not a failed run
        catch: (error) =>
          error instanceof SyntaxError
            ? `code did not evaluate: ${error}`
            : `program failed: ${error}`,
      });
      return { output, logs };
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            `eval timed out after ${Duration.format(
              Duration.fromInputUnsafe(timeout),
            )} — split the work into smaller programs`,
          ),
      }),
    ),
});

const format = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
