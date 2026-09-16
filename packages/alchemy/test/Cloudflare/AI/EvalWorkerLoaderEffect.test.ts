/**
 * UNIT tests for {@link rewriteEffectImports} — the source transform
 * `EvalWorkerLoaderEffect` applies to every module of the request graph
 * before the isolate loads it. The isolate's module map has no
 * node_modules, so `effect` import STATEMENTS must become destructures
 * of the bundled monolith namespace the prelude imports; everything
 * else must pass through byte-for-byte.
 *
 * The matrix here mirrors `test/AI/EvalFunction.test.ts`'s import
 * matrix (the in-process rewriter), so the two rewriters are held to
 * the same syntax coverage: every clause shape, statement position,
 * quoting, and pass-through case.
 */
import {
  effectTransform,
  rewriteEffectImports,
} from "@/Cloudflare/AI/EvalWorkerLoaderEffect.ts";
import { describe, expect, it } from "alchemy-test";

describe("rewriteEffectImports", () => {
  describe("namespace imports (import * as X)", () => {
    it("rewrites a namespace import of a submodule", () => {
      expect(
        rewriteEffectImports(`import * as Effect from "effect/Effect";`),
      ).toBe(`const Effect = effect.Effect;`);
    });

    it("rewrites a namespace import of the ROOT package", () => {
      expect(
        rewriteEffectImports(`import * as everything from "effect";`),
      ).toBe(`const everything = effect;`);
    });

    it("keeps the local alias, not the module name", () => {
      expect(
        rewriteEffectImports(`import * as Dur from "effect/Duration";`),
      ).toBe(`const Dur = effect.Duration;`);
    });

    it("accepts single quotes", () => {
      expect(rewriteEffectImports(`import * as Data from 'effect/Data';`)).toBe(
        `const Data = effect.Data;`,
      );
    });

    it("accepts a missing semicolon", () => {
      expect(rewriteEffectImports(`import * as Exit from "effect/Exit"`)).toBe(
        `const Exit = effect.Exit;`,
      );
    });

    it("accepts dollar/underscore identifiers", () => {
      expect(
        rewriteEffectImports(`import * as _$E from "effect/Effect";`),
      ).toBe(`const _$E = effect.Effect;`);
    });

    it("tolerates tight and loose whitespace", () => {
      expect(
        rewriteEffectImports(`import *as Effect from "effect/Effect";`),
      ).toBe(`const Effect = effect.Effect;`);
      expect(
        rewriteEffectImports(
          `import   *   as   Effect   from   "effect/Effect" ;`,
        ),
      ).toBe(`const Effect = effect.Effect;`);
    });
  });

  describe("named imports", () => {
    it("rewrites a single named import", () => {
      expect(rewriteEffectImports(`import { gen } from "effect/Effect";`)).toBe(
        `const { gen } = effect.Effect;`,
      );
    });

    it("rewrites multiple named imports", () => {
      expect(
        rewriteEffectImports(`import { map, flatMap } from "effect/Effect";`),
      ).toBe(`const { map, flatMap } = effect.Effect;`);
    });

    it("converts `as` renames to destructure aliases", () => {
      expect(
        rewriteEffectImports(
          `import { flatMap as fm, map } from "effect/Effect";`,
        ),
      ).toBe(`const { flatMap: fm, map } = effect.Effect;`);
    });

    it("rewrites multi-line named imports (trailing comma survives)", () => {
      expect(
        rewriteEffectImports(
          [
            `import {`,
            `  map,`,
            `  flatMap as fm,`,
            `} from "effect/Effect";`,
          ].join("\n"),
        ),
      ).toBe(
        [`const {`, `  map,`, `  flatMap: fm,`, `} = effect.Effect;`].join(
          "\n",
        ),
      );
    });

    it("rewrites root named imports to the namespace itself", () => {
      expect(
        rewriteEffectImports(`import { Effect, Duration } from "effect";`),
      ).toBe(`const { Effect, Duration } = effect;`);
    });

    it("converts root `as` renames", () => {
      expect(rewriteEffectImports(`import { Effect as E } from 'effect'`)).toBe(
        `const { Effect: E } = effect;`,
      );
    });
  });

  describe("other statement forms", () => {
    it("drops a side-effect-only import (nothing to run)", () => {
      expect(rewriteEffectImports(`import "effect/Effect";`).trim()).toBe("");
    });

    it("re-exports named bindings off the namespace", () => {
      expect(rewriteEffectImports(`export { gen } from "effect/Effect";`)).toBe(
        `const { gen } = effect.Effect; export { gen };`,
      );
    });

    it("a re-export ALIAS binds and exports the alias", () => {
      // `b as c` takes `b` from the module and exports it as `c`, so the
      // local binding — and the re-export — must be `c`
      expect(
        rewriteEffectImports(
          `export { gen as generate } from "effect/Effect";`,
        ),
      ).toBe(`const { gen: generate } = effect.Effect; export { generate };`);
    });
  });

  describe("statement position (minified / multi-statement lines)", () => {
    it("rewrites a second statement on the SAME line", () => {
      expect(
        rewriteEffectImports(
          `import * as Effect from "effect/Effect";import { millis } from "effect/Duration";`,
        ),
      ).toBe(
        `const Effect = effect.Effect;const { millis } = effect.Duration;`,
      );
    });

    it("rewrites fully minified imports (no spaces)", () => {
      expect(
        rewriteEffectImports(`import*as Effect from"effect/Effect";`),
      ).toBe(`const Effect = effect.Effect;`);
      // the clause is copied verbatim, so a minified clause stays tight
      expect(rewriteEffectImports(`import{gen}from"effect/Effect";`)).toBe(
        `const {gen} = effect.Effect;`,
      );
    });

    it("rewrites INDENTED imports, preserving the indentation", () => {
      expect(
        rewriteEffectImports(`  import * as Data from "effect/Data";`),
      ).toBe(`  const Data = effect.Data;`);
    });
  });

  describe("what must pass through untouched", () => {
    it("leaves non-effect imports alone", () => {
      const code = `import fs from "node:fs";\nimport { z } from "zod";`;
      expect(rewriteEffectImports(code)).toBe(code);
    });

    it("leaves scoped @effect packages alone (different package)", () => {
      const code = `import { NodeServices } from "@effect/platform-node";`;
      expect(rewriteEffectImports(code)).toBe(code);
    });

    it("leaves lookalike package names alone", () => {
      const code = [
        `import { a } from "effects";`,
        `import { b } from "effect-utils/thing";`,
        `import * as c from "effectful";`,
      ].join("\n");
      expect(rewriteEffectImports(code)).toBe(code);
    });

    it("leaves DEEP subpaths alone (the monolith has only top-level modules)", () => {
      const code = `import { HttpClient } from "effect/unstable/http/HttpClient";`;
      expect(rewriteEffectImports(code)).toBe(code);
    });

    it("leaves default imports alone (effect modules have no default export)", () => {
      const code = `import Effect from "effect/Effect";`;
      expect(rewriteEffectImports(code)).toBe(code);
    });

    it("leaves relative tool imports alone", () => {
      const code = `import { search } from "./tools.js";`;
      expect(rewriteEffectImports(code)).toBe(code);
    });

    it("leaves ordinary code alone, including the word import mid-line", () => {
      const code = [
        `const label = "the import { x } from 'effect/Effect' statement";`,
        `console.log("re-import * as Effect from 'effect/Effect'");`,
        `return await tools.search({ query: "import" });`,
      ].join("\n");
      expect(rewriteEffectImports(code)).toBe(code);
    });
  });

  describe("in real program shapes", () => {
    it("rewrites imports embedded in a program and leaves the body intact", () => {
      const program = [
        `import * as Effect from "effect/Effect";`,
        `import { Duration } from "effect";`,
        `import { search } from "./tools.js";`,
        ``,
        `export default Effect.gen(function* () {`,
        `  const first = yield* search({ query: "alchemy" });`,
        `  yield* Effect.sleep(Duration.millis(1));`,
        `  return first;`,
        `});`,
      ].join("\n");
      expect(rewriteEffectImports(program)).toBe(
        [
          `const Effect = effect.Effect;`,
          `const { Duration } = effect;`,
          `import { search } from "./tools.js";`,
          ``,
          `export default Effect.gen(function* () {`,
          `  const first = yield* search({ query: "alchemy" });`,
          `  yield* Effect.sleep(Duration.millis(1));`,
          `  return first;`,
          `});`,
        ].join("\n"),
      );
    });

    it("is idempotent", () => {
      const program = [
        `import * as Effect from "effect/Effect";`,
        `import { flatMap as fm } from "effect/Effect";`,
        `import { Duration } from "effect";`,
        `export default Effect.void;`,
      ].join("\n");
      const once = rewriteEffectImports(program);
      expect(rewriteEffectImports(once)).toBe(once);
    });

    it("the rewritten bindings are legal STATEMENTS", () => {
      const rewritten = rewriteEffectImports(
        [
          `import * as Effect from "effect/Effect";`,
          `import { map, flatMap as fm } from "effect/Effect";`,
          `import { Duration as D } from "effect";`,
        ].join("\n"),
      );
      // no `import` survives, and the result parses as a function body
      expect(rewritten).not.toContain("import");
      expect(
        () =>
          new Function("effect", `${rewritten}\nreturn [Effect, map, fm, D];`),
      ).not.toThrow();
    });
  });

  describe("effectTransform", () => {
    it("prepends a REAL namespace import of the monolith", () => {
      const transformed = effectTransform(
        `import * as Effect from "effect/Effect";\nexport default Effect.void;`,
      );
      expect(transformed.split("\n")[0]).toBe(
        `import * as effect from "./effect.js";`,
      );
      expect(transformed).toContain(`const Effect = effect.Effect;`);
    });

    it("still prepends for a module that imports nothing from effect", () => {
      // one unused import is harmless; the alternative is scanning for
      // usage, which a rewrite cannot do reliably
      const transformed = effectTransform(`export default async () => 1;`);
      expect(transformed).toContain(`import * as effect from "./effect.js";`);
      expect(transformed).toContain(`export default async () => 1;`);
    });
  });
});
