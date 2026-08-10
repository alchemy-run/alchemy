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
 * Point `effect` import statements at the MONOLITH `./effect.js` the
 * isolate carries. The isolate's module map has no node_modules, so a
 * bare `effect/X` specifier cannot resolve; the runtime is one bundled
 * file exporting each top-level module as a named NAMESPACE (`Effect`,
 * `Data`, …), so the statements become destructures of an
 * `import * as effect from "./effect.js"` the {@link effectTransform}
 * prepends:
 *
 * - `import * as X from "effect/Y"`        → `const X = effect.Y;`
 * - `import { a, b as c } from "effect/Y"` → `const { a, b: c } = effect.Y;`
 * - `import { a } from "effect"`           → `const { a } = effect;`
 *
 * (A split per-module runtime would let these stay verbatim `import`s;
 * the monolith trades that for one file. Kept as a rewrite so the
 * generated runtime stays a single artifact.)
 */
export const rewriteEffectImports = (code: string): string =>
  code
    .replaceAll(
      /^\s*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+["']effect\/(\w+)["'];?/gm,
      "const $1 = effect.$2;",
    )
    .replaceAll(
      /^\s*import\s*\{([^}]*)\}\s*from\s+["']effect\/(\w+)["'];?/gm,
      (_match, names: string, module: string) =>
        `const {${names.replaceAll(/\s+as\s+/g, ": ")}} = effect.${module};`,
    )
    .replaceAll(
      /^\s*import\s*\{([^}]*)\}\s*from\s+["']effect["'];?/gm,
      (_match, names: string) =>
        `const {${names.replaceAll(/\s+as\s+/g, ": ")}} = effect;`,
    );

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
