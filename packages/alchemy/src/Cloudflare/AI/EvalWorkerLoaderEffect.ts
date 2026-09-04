import type * as Layer from "effect/Layer";
import type { Eval } from "../../AI/Eval.ts";
import type { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import {
  EFFECT_RUNTIME,
  EFFECT_RUNTIME_MODULES,
} from "./EvalEffectRuntime.generated.ts";
import {
  EvalWorkerLoader,
  type EvalWorkerLoaderOptions,
} from "./EvalWorkerLoader.ts";

export interface EvalWorkerLoaderEffectOptions extends EvalWorkerLoaderOptions {}

/**
 * Statement position: start of a line, or right after `;`/`{`/`}` — a
 * minified module puts several statements on one line. The leading
 * whitespace is matched inside the LOOKBEHIND so it is not consumed:
 * indentation and the newlines between statements survive the rewrite
 * (line numbers keep pointing at the model's own source).
 */
const AT = String.raw`(?<=(?:^|[;{}])\s*)`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
/** A top-level effect module (`effect/Effect`) or the root (`effect`). */
const SPECIFIER = String.raw`["']effect(?:\/(\w+))?["']\s*;?`;
const statement = (pattern: string) => new RegExp(`${AT}${pattern}`, "gm");

/** `effect/Effect` → `effect.Effect`; the root → `effect`. */
const namespaceOf = (module: string | undefined) =>
  module === undefined ? "effect" : `effect.${module}`;

/** `a, b as c` (import clause) → `a, b: c` (destructure pattern). */
const destructure = (names: string) => names.replaceAll(/\s+as\s+/g, ": ");

/** The LOCAL names an import/export clause binds (`b as c` binds `c`). */
const locals = (names: string): string =>
  names
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(/\s+as\s+/).at(-1)!)
    .join(", ");

/**
 * Point `effect` import statements at the MONOLITH `./effect.js` the
 * isolate carries. The isolate's module map has no node_modules, so a
 * bare `effect/X` specifier cannot resolve; the runtime is one bundled
 * file exporting each top-level module as a named NAMESPACE (`Effect`,
 * `Data`, …), so the statements become destructures of an
 * `import * as effect from "./effect.js"` the {@link effectTransform}
 * prepends. Both `effect/X` and the root `effect` are handled:
 *
 * - `import * as X from "effect/Y"`        → `const X = effect.Y;`
 * - `import { a, b as c } from "effect/Y"` → `const { a, b: c } = effect.Y;`
 * - `import * as X from "effect"`          → `const X = effect;`
 * - `import { a } from "effect"`           → `const { a } = effect;`
 * - `import "effect/Y"`                    → dropped (no side effects to run)
 * - `export { a, b as c } from "effect/Y"` → re-exported off the namespace
 *
 * DELIBERATELY not rewritten, because the monolith cannot satisfy them —
 * each fails to resolve with the runtime's own module-not-found error,
 * which names the specifier:
 *
 * - `import X from "effect/Y"` — effect modules have no default export;
 * - `import … from "effect/unstable/…"` — the runtime carries only
 *   stable TOP-LEVEL modules.
 *
 * (A split per-module runtime would let all of these stay verbatim
 * `import`s; the monolith trades that for one file.)
 */
export const rewriteEffectImports = (code: string): string =>
  code
    .replaceAll(
      statement(String.raw`import\s*\*\s*as\s+(${NAME})\s+from\s*${SPECIFIER}`),
      (_match, name: string, module: string | undefined) =>
        `const ${name} = ${namespaceOf(module)};`,
    )
    .replaceAll(
      statement(String.raw`import\s*\{([^}]*)\}\s*from\s*${SPECIFIER}`),
      (_match, names: string, module: string | undefined) =>
        `const {${destructure(names)}} = ${namespaceOf(module)};`,
    )
    .replaceAll(
      statement(String.raw`export\s*\{([^}]*)\}\s*from\s*${SPECIFIER}`),
      // `export { b as c } from "effect/Y"` binds LOCAL `c`, so the
      // re-export names the alias, not the module's own name
      (_match, names: string, module: string | undefined) =>
        `const {${destructure(names)}} = ${namespaceOf(module)}; export { ${locals(names)} };`,
    )
    .replaceAll(statement(String.raw`import\s*${SPECIFIER}`), "");

/**
 * The full transform applied to every module of the request graph: a
 * real `import * as effect from "./effect.js"` (the monolith
 * namespace) followed by {@link rewriteEffectImports}. Import
 * statements hoist, so the prepended import is initialized before the
 * rewritten `const X = effect.X` bindings run — a module that imports
 * nothing from effect just carries one unused import.
 */
export const effectTransform = (source: string): string =>
  `import * as effect from "./effect.js";\n${rewriteEffectImports(source)}`;

/**
 * {@link EvalWorkerLoader} with the EFFECT RUNTIME in scope — the
 * isolated evaluator for `AI.CodeModeEffect`.
 *
 * The generated `EvalEffectRuntime.generated.ts` (every stable
 * top-level effect module, one ~763KB self-contained ESM file, built
 * by `bun generate:eval-runtime`) is added to the isolate's module map
 * as `./effect.js`; {@link effectTransform} rewrites the model's and
 * convention's `import … from "effect/X"` statements to reference it,
 * so real-world effect code runs unchanged.
 *
 * Kept SEPARATE from the base evaluator so async-only workers never
 * carry the runtime string — importing this module is what opts a
 * bundle into it.
 *
 * ```ts
 * Effect.provide(AI.CodeModeEffect())
 * Effect.provide(Cloudflare.AI.EvalWorkerLoaderEffect())
 * ```
 */
export const EvalWorkerLoaderEffect = (
  options?: EvalWorkerLoaderEffectOptions,
): Layer.Layer<Eval, never, Worker | WorkerEnvironment> =>
  EvalWorkerLoader({
    ...options,
    modules: { "effect.js": EFFECT_RUNTIME, ...options?.modules },
    transform: options?.transform ?? effectTransform,
  });

export { EFFECT_RUNTIME_MODULES };
