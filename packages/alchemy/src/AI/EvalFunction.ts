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

/** Statement position: start of a line, or right after `;`/`{`/`}` —
 *  a module may put several statements on one line. */
const AT = String.raw`(?<=^|[;{}])\s*`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
// exactly ONE capture group (the specifier) so composed rules number
// their own groups predictably — no backreference, since a quote
// mismatch like `"x'` is not worth a shifting group index
const FROM = String.raw`from\s*["']([^"']+)["']\s*;?`;
const statement = (pattern: string) => new RegExp(`${AT}${pattern}`, "gm");

/** `a, b as c` (import clause) → `a, b: c` (destructure pattern). */
const destructure = (names: string) => names.replaceAll(/\s+as\s+/g, ": ");

/**
 * Compile one ES module SOURCE into an async function: import and
 * export statements become `await __require(...)` lookups and
 * `__exports` assignments, so the module runs as a plain function with
 * its dependencies — including the tools namespace, as REAL closures —
 * passed in. The rewritten statement forms:
 *
 * - `import * as X from "s"`        → `const X = await __require("s")`
 * - `import { a, b as c } from "s"` → `const { a, b: c } = await __require("s")`
 * - `import X from "s"`             → `const X = (await __require("s")).default`
 * - `import X, { a } from "s"`      → both of the above
 * - `import "s"`                    → `await __require("s")` (side effects)
 * - `export * from "s"`             → `Object.assign(__exports, await __require("s"))`
 * - `export const x = …`            → `__exports.x = …`
 * - `export default …`              → `__exports.default = …`
 *
 * Known limitation: rewriting is lexical (statement-position regexes),
 * so an import-shaped LINE inside a template literal would be
 * rewritten. Mid-line strings are safe.
 */
const compileModule = (source: string) =>
  new AsyncFunction(
    "__require",
    "__exports",
    "console",
    source
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
      .replaceAll(
        statement(String.raw`export\s+(?:const|let)\s+(${NAME})\s*=`),
        (_match, name: string) => `__exports.${name} =`,
      )
      .replaceAll(
        statement(String.raw`export\s+default\s+`),
        () => `__exports.default = `,
      ),
  );

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
