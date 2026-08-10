/**
 * UNIT tests for {@link rewriteEffectImports} — the source transform
 * `EvalWorkerLoaderEffect` applies to model-authored code before it is
 * wrapped into the isolate's program module. The isolate's module map
 * has no node_modules, so `effect` import STATEMENTS must become
 * destructures of the bundled `effect` namespace the prelude provides;
 * everything else must pass through byte-for-byte.
 */
import { rewriteEffectImports } from "@/Cloudflare/AI/EvalWorkerLoaderEffect.ts";
import { describe, expect, it } from "alchemy-test";

describe("rewriteEffectImports", () => {
  describe("namespace imports (import * as X)", () => {
    it("rewrites a namespace import of a submodule", () => {
      expect(
        rewriteEffectImports(`import * as Effect from "effect/Effect";`),
      ).toBe(`const Effect = effect.Effect;`);
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
      ).toBe(`const Effect = effect.Effect; ;`);
    });
  });

  describe("named imports from a submodule", () => {
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
  });

  describe("named imports from the effect root", () => {
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

    it("leaves DEEP subpaths alone (not part of the bundled runtime)", () => {
      const code = `import { HttpClient } from "effect/unstable/http";`;
      expect(rewriteEffectImports(code)).toBe(code);
    });

    it("leaves default imports alone (no such export on the runtime)", () => {
      const code = `import Effect from "effect/Effect";`;
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
        ``,
        `return Effect.gen(function* () {`,
        `  const first = yield* tools.search({ query: "alchemy" });`,
        `  yield* Effect.sleep(Duration.millis(1));`,
        `  return first;`,
        `});`,
      ].join("\n");
      expect(rewriteEffectImports(program)).toBe(
        [
          `const Effect = effect.Effect;`,
          `const { Duration } = effect;`,
          ``,
          `return Effect.gen(function* () {`,
          `  const first = yield* tools.search({ query: "alchemy" });`,
          `  yield* Effect.sleep(Duration.millis(1));`,
          `  return first;`,
          `});`,
        ].join("\n"),
      );
    });

    it("rewrites INDENTED imports (models indent freely)", () => {
      expect(
        rewriteEffectImports(`  import * as Data from "effect/Data";`),
      ).toBe(`const Data = effect.Data;`);
    });

    it("is idempotent", () => {
      const program = [
        `import * as Effect from "effect/Effect";`,
        `import { flatMap as fm } from "effect/Effect";`,
        `import { Duration } from "effect";`,
        `return Effect.void;`,
      ].join("\n");
      const once = rewriteEffectImports(program);
      expect(rewriteEffectImports(once)).toBe(once);
    });

    it("output is syntactically valid JavaScript", () => {
      const rewritten = rewriteEffectImports(
        [
          `import * as Effect from "effect/Effect";`,
          `import { map, flatMap as fm } from "effect/Effect";`,
          `import { Duration as D } from "effect";`,
          `return Effect.void;`,
        ].join("\n"),
      );
      // wraps like programModule does: body position, so the rewritten
      // import lines must be legal STATEMENTS (imports would throw here)
      expect(
        () =>
          new Function(
            "tools",
            "effect",
            `return (async () => {\n${rewritten}\n})()`,
          ),
      ).not.toThrow();
    });
  });
});
