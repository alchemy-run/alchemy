/**
 * The in-process {@link Eval} implementation, exhaustively: module
 * compilation (import/export rewriting is the tricky part), graph
 * linking and memoization, the reserved `tools.raw.js` closures,
 * failure identity across the bridge (`_tag` preserved — what the
 * effect convention's `catchTag` relies on), console capture, and
 * error/timeout surfacing.
 */
import { Eval, type EvalTool } from "@/AI/Eval.ts";
import { EvalFunction } from "@/AI/EvalFunction.ts";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

class Missing extends Data.TaggedError("Missing")<{ path: string }> {}

const run = (
  modules: Record<string, string>,
  options?: {
    readonly tools?: ReadonlyArray<EvalTool>;
    readonly main?: string;
    readonly timeout?: Duration.Input;
  },
) =>
  Effect.gen(function* () {
    const evaluator = yield* Eval;
    return yield* evaluator.run({
      modules,
      main: options?.main ?? "main.js",
      tools: options?.tools ?? [],
      timeout: options?.timeout ?? "10 seconds",
    });
  }).pipe(Effect.provide(EvalFunction));

const echo: EvalTool = {
  name: "echo",
  call: (input) => Effect.succeed({ echoed: input }),
};

const search: EvalTool = {
  name: "search",
  call: (input) =>
    Effect.succeed(`results for ${(input as { query: string }).query}`),
};

const readFile: EvalTool = {
  name: "readFile",
  call: (input) =>
    Effect.fail(new Missing({ path: (input as { path: string }).path })),
};

describe("EvalFunction", () => {
  describe("execution", () => {
    it.live("runs a default-exported async function", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "main.js": `export default async function () { return 41 + 1; }`,
        });
        expect(result.output).toBe(42);
        expect(result.logs).toEqual([]);
      }),
    );

    it.live("runs a default-exported arrow thunk", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "main.js": `export default async () => "arrow";`,
        });
        expect(result.output).toBe("arrow");
      }),
    );

    it.live("an undefined return is a valid output", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "main.js": `export default async function () {}`,
        });
        expect(result.output).toBeUndefined();
      }),
    );

    it.live("a missing default export is model-visible", () =>
      Effect.gen(function* () {
        const error = yield* run({
          "main.js": `export const nope = 1;`,
        }).pipe(Effect.flip);
        expect(error).toContain("no default export");
      }),
    );

    it.live("a syntax error is 'code did not evaluate'", () =>
      Effect.gen(function* () {
        const error = yield* run({
          "main.js": `export default async function () { return ] }`,
        }).pipe(Effect.flip);
        expect(error).toContain("code did not evaluate");
        expect(error).toContain("SyntaxError");
      }),
    );

    it.live("a runtime throw is 'program failed'", () =>
      Effect.gen(function* () {
        const error = yield* run({
          "main.js": `export default async function () { throw new Error("boom"); }`,
        }).pipe(Effect.flip);
        expect(error).toBe("program failed: Error: boom");
      }),
    );

    it.live("a reference to an unknown name fails the program", () =>
      Effect.gen(function* () {
        const error = yield* run({
          "main.js": `export default async function () { return await nope(); }`,
        }).pipe(Effect.flip);
        expect(error).toContain("program failed");
      }),
    );
  });

  describe("import rewriting", () => {
    it.live("bare namespace import resolves via the host (effect/*)", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "main.js": `
            import * as Effect from "effect/Effect";
            export default () => Effect.runPromise(Effect.succeed("bare"));`,
        });
        expect(result.output).toBe("bare");
      }),
    );

    it.live("bare NAMED imports resolve via the host", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "main.js": `
            import { succeed, runPromise } from "effect/Effect";
            export default () => runPromise(succeed("named-bare"));`,
        });
        expect(result.output).toBe("named-bare");
      }),
    );

    it.live("relative imports resolve within the graph", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `export const shout = (s) => s.toUpperCase();`,
          "main.js": `
            import { shout } from "./helper.js";
            export default async function () { return shout("quiet"); }`,
        });
        expect(result.output).toBe("QUIET");
      }),
    );

    it.live("EXTENSIONLESS relative imports resolve to the .js entry", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `export const n = 7;`,
          "main.js": `
            import { n } from "./helper";
            export default async function () { return n; }`,
        });
        expect(result.output).toBe(7);
      }),
    );

    it.live("default imports from graph modules", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `export default 99;`,
          "main.js": `
            import value from "./helper.js";
            export default async function () { return value; }`,
        });
        expect(result.output).toBe(99);
      }),
    );

    it.live("aliased named imports (`as`) become destructure aliases", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `export const long = 1; export const other = 2;`,
          "main.js": `
            import { long as l, other } from "./helper.js";
            export default async function () { return l + other; }`,
        });
        expect(result.output).toBe(3);
      }),
    );

    it.live("multi-line named imports", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `export const a = 1;\nexport const b = 2;`,
          "main.js": `
            import {
              a,
              b,
            } from "./helper.js";
            export default async function () { return a + b; }`,
        });
        expect(result.output).toBe(3);
      }),
    );

    it.live("single quotes and missing semicolons", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `export const x = "sq"`,
          "main.js": `
            import { x } from './helper.js'
            export default async function () { return x }`,
        });
        expect(result.output).toBe("sq");
      }),
    );

    it.live("`export * from` re-exports a whole module", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "inner.js": `export const a = "A"; export const b = "B";`,
          "outer.js": `export * from "./inner.js";`,
          "main.js": `
            import { a, b } from "./outer.js";
            export default async function () { return a + b; }`,
        });
        expect(result.output).toBe("AB");
      }),
    );

    it.live("import-shaped text INSIDE code is not rewritten", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "main.js": `
            export default async function () {
              const s = 'import { x } from "./nowhere.js"';
              return s.includes("nowhere");
            }`,
        });
        expect(result.output).toBe(true);
      }),
    );

    it.live("an unknown RELATIVE import fails model-visibly", () =>
      Effect.gen(function* () {
        const error = yield* run({
          "main.js": `
            import { x } from "./missing.js";
            export default async function () { return x; }`,
        }).pipe(Effect.flip);
        expect(error).toContain("program failed");
      }),
    );

    it.live("MIXED default + named imports", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `export default "D"; export const named = "N";`,
          "main.js": `
            import d, { named } from "./helper.js";
            export default async function () { return d + named; }`,
        });
        expect(result.output).toBe("DN");
      }),
    );

    it.live("side-effect-only imports run the module", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "setup.js": `console.log("setup-ran");`,
          "main.js": `
            import "./setup.js";
            export default async function () { return "ok"; }`,
        });
        expect(result.output).toBe("ok");
        expect(result.logs).toEqual(["setup-ran"]);
      }),
    );

    it.live("namespace imports of GRAPH modules", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `export const a = 1; export const b = 2;`,
          "main.js": `
            import * as helper from "./helper.js";
            export default async function () { return helper.a + helper.b; }`,
        });
        expect(result.output).toBe(3);
      }),
    );

    it.live("bare DEFAULT imports resolve via the host (node:path)", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "main.js": `
            import path from "node:path";
            export default async function () { return path.join("a", "b"); }`,
        });
        expect(result.output).toBe("a/b");
      }),
    );

    it.live("`export * from` a BARE module re-exports the host module", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "re.js": `export * from "effect/Duration";`,
          "main.js": `
            import { millis, toMillis } from "./re.js";
            export default async function () { return toMillis(millis(5)); }`,
        });
        expect(result.output).toBe(5);
      }),
    );

    it.live("MINIFIED one-liner modules (no spaces, statements joined)", () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            "main.js": `import{search}from"./tools.raw.js";export default async function(){return search({query:"q"});}`,
          },
          { tools: [search] },
        );
        expect(result.output).toBe("results for q");
      }),
    );

    it.live("modules are instantiated ONCE (memoized across importers)", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "counter.js": `console.log("counter-init"); export const n = 1;`,
          "left.js": `import { n } from "./counter.js"; export const left = n;`,
          "right.js": `import { n } from "./counter.js"; export const right = n;`,
          "main.js": `
            import { left } from "./left.js";
            import { right } from "./right.js";
            export default async function () { return left + right; }`,
        });
        expect(result.output).toBe(2);
        expect(result.logs).toEqual(["counter-init"]);
      }),
    );
  });

  describe("tools", () => {
    it.live("the reserved tools.raw.js exposes granted handlers", () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            "main.js": `
              import { echo } from "./tools.raw.js";
              export default async function () { return echo({ n: 1 }); }`,
          },
          { tools: [echo] },
        );
        expect(result.output).toEqual({ echoed: { n: 1 } });
      }),
    );

    it.live("a convention-style adapter graph reaches the tools", () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            "tools.js": `export * from "./tools.raw.js";`,
            "program.js": `
              import { search } from "./tools.js";
              export default async function () {
                const first = await search({ query: "alchemy" });
                const second = await search({ query: "effect" });
                return first + " // " + second;
              }`,
            "main.js": `
              import program from "./program.js";
              export default () => program();`,
          },
          { tools: [search], main: "main.js" },
        );
        expect(result.output).toBe("results for alchemy // results for effect");
      }),
    );

    it.live("a tool FAILURE rejects with the failure value, _tag intact", () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            "main.js": `
              import { readFile } from "./tools.raw.js";
              export default async function () {
                try {
                  await readFile({ path: "/tmp/x" });
                  return "unreachable";
                } catch (error) {
                  return { tag: error._tag, path: error.path };
                }
              }`,
          },
          { tools: [readFile] },
        );
        expect(result.output).toEqual({ tag: "Missing", path: "/tmp/x" });
      }),
    );

    it.live("the effect adapter makes declared failures catchable by TAG", () =>
      Effect.gen(function* () {
        // the exact adapter shape CodeModeEffect generates
        const result = yield* run(
          {
            "tools.js": `
              import * as Effect from "effect/Effect";
              import * as raw from "./tools.raw.js";
              const lift = (call) => (input) =>
                Effect.tryPromise({ try: () => call(input), catch: (error) => error });
              export const readFile = lift(raw.readFile);`,
            "program.js": `
              import * as Effect from "effect/Effect";
              import { readFile } from "./tools.js";
              export default Effect.gen(function* () {
                return yield* readFile({ path: "/tmp/x" });
              }).pipe(Effect.catchTag("Missing", (e) => Effect.succeed("caught:" + e.path)));`,
            "main.js": `
              import * as Effect from "effect/Effect";
              import program from "./program.js";
              export default () => Effect.runPromise(program);`,
          },
          { tools: [readFile] },
        );
        expect(result.output).toBe("caught:/tmp/x");
      }),
    );

    it.live("tools compose CONCURRENTLY (Promise.all)", () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            "main.js": `
              import { search } from "./tools.raw.js";
              export default async function () {
                const [a, b] = await Promise.all([
                  search({ query: "one" }),
                  search({ query: "two" }),
                ]);
                return a + " & " + b;
              }`,
          },
          { tools: [search] },
        );
        expect(result.output).toBe("results for one & results for two");
      }),
    );

    it.live("calling a tool that was never granted fails the program", () =>
      Effect.gen(function* () {
        const error = yield* run(
          {
            "main.js": `
              import { nope } from "./tools.raw.js";
              export default async function () { return nope({}); }`,
          },
          { tools: [echo] },
        );
        // destructuring a missing export yields undefined; calling it throws
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => expect(String(error)).toContain("program failed")),
        ),
      ),
    );
  });

  describe("console capture", () => {
    it.live("captures every level, prefixed (log bare)", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "main.js": `
            export default async function () {
              console.log("plain", { n: 1 });
              console.info("fyi");
              console.warn("careful");
              console.error("bad");
              console.debug("detail");
              return "ok";
            }`,
        });
        expect(result.logs).toEqual([
          `plain {"n":1}`,
          `[info] fyi`,
          `[warn] careful`,
          `[error] bad`,
          `[debug] detail`,
        ]);
      }),
    );

    it.live("the GLOBAL console is untouched", () =>
      Effect.gen(function* () {
        const before = globalThis.console;
        yield* run({
          "main.js": `
            export default async function () { console.log("captured"); }`,
        });
        expect(globalThis.console).toBe(before);
      }),
    );

    it.live("logs from imported modules are captured too", () =>
      Effect.gen(function* () {
        const result = yield* run({
          "helper.js": `console.log("from-helper"); export const x = 1;`,
          "main.js": `
            import { x } from "./helper.js";
            export default async function () { return x; }`,
        });
        expect(result.logs).toEqual(["from-helper"]);
      }),
    );
  });

  describe("timeout", () => {
    it.live("a runaway program is cut off with a model-visible message", () =>
      Effect.gen(function* () {
        const error = yield* run(
          {
            "main.js": `
              export default () => new Promise((resolve) => setTimeout(resolve, 5_000));`,
          },
          { timeout: "250 millis" },
        ).pipe(Effect.flip);
        expect(error).toContain("eval timed out");
      }),
    );
  });
});
