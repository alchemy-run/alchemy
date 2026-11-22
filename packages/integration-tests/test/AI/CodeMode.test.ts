import * as AI from "@alchemy.run/ai";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
  balance: Schema.Number,
}) {}

const declared = {
  tools: [
    {
      name: "add",
      description: "Add two integers.",
      parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
      success: Schema.Struct({ sum: Schema.Number }),
    },
    {
      name: "withdraw",
      description: "Withdraw money from an account.",
      parameters: Schema.Struct({ amount: Schema.Number }),
      success: Schema.Struct({ balance: Schema.Number }),
      failure: InsufficientFunds,
    },
  ],
} satisfies Omit<AI.DeclaredNamespace, "name">;

/** The tools as a harness hands them over: a declared failure rejects with its fields as JSON. */
const tools: AI.ScriptTools = {
  add: async (args) => {
    const { a, b } = args as { a: number; b: number };
    return { sum: a + b };
  },
  withdraw: async (args) => {
    const { amount } = args as { amount: number };
    if (amount > 137) {
      return Promise.reject(new Error(JSON.stringify({ _tag: "InsufficientFunds", balance: 137 })));
    }
    return { balance: 137 - amount };
  },
};

/** Run `code` as a model would send it, in QuickJS on this machine. */
const run = (CodeModeLive: Layer.Layer<AI.CodeModeConvention, never, AI.Eval>, code: string) =>
  Effect.gen(function* () {
    const codemode = yield* AI.CodeModeConvention;
    if (codemode.kind !== "shared") return yield* Effect.die("expected a shared convention");
    const convention = yield* codemode.convention;
    return yield* codemode.evaluator.run(convention.program(declared).wrap(code), tools);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(CodeModeLive.pipe(Layer.provide(AI.EvalQuickJS())), RuntimeContext.phantom),
    ),
  );

describe("AI.programBody", { tags: ["unit"] }, () => {
  it("a module returns its default export, and its imports are lookups", () => {
    expect(
      AI.programBody(
        [
          'import { Effect, Option as O } from "effect";',
          'import * as Arr from "effect/Array";',
          "export const double = (n) => n * 2;",
          "export default Effect.succeed(double(2));",
        ].join("\n"),
      ),
    ).toEqual({
      module: true,
      body: [
        'const { Effect, Option: O } = __alchemyImport("effect");',
        'const Arr = __alchemyImport("effect/Array");',
        "const double = (n) => n * 2;",
        "const __alchemyDefault = Effect.succeed(double(2));",
        "return __alchemyDefault;",
      ].join("\n"),
    });
  });

  it("a function body is left as it is, without the fence a model put around it", () => {
    expect(AI.programBody("```js\nreturn 1;\n```")).toEqual({ module: false, body: "return 1;" });
  });
});

describe("AI.CodeModeAsync", { tags: ["unit"] }, () => {
  it.effect("a module's default export is the result", () =>
    Effect.gen(function* () {
      const result = yield* run(
        AI.CodeModeAsync,
        "const { sum } = await tools.add({ a: 2, b: 3 });\nexport default sum;",
      );
      expect(result).toEqual({ ok: true, value: 5, output: [] });
    }),
  );

  it.effect("a default export that is a function is called", () =>
    Effect.gen(function* () {
      const result = yield* run(
        AI.CodeModeAsync,
        "export default async function () {\n  return (await tools.add({ a: 2, b: 3 })).sum;\n}",
      );
      expect(result).toEqual({ ok: true, value: 5, output: [] });
    }),
  );

  it.effect("the body of an async function still runs", () =>
    Effect.gen(function* () {
      const result = yield* run(AI.CodeModeAsync, "return (await tools.add({ a: 2, b: 3 })).sum;");
      expect(result).toEqual({ ok: true, value: 5, output: [] });
    }),
  );

  it.effect("a declared failure is an instance of its class", () =>
    Effect.gen(function* () {
      const result = yield* run(
        AI.CodeModeAsync,
        [
          "export default await tools.withdraw({ amount: 500 }).catch((error) =>",
          "  error instanceof tools.InsufficientFunds ? error.balance : -1,",
          ");",
        ].join("\n"),
      );
      expect(result).toEqual({ ok: true, value: 137, output: [] });
    }),
  );

  it.effect("an import fails and says nothing can be imported", () =>
    Effect.gen(function* () {
      const result = yield* run(AI.CodeModeAsync, 'import fs from "node:fs";\nexport default 1;');
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toContain('Programs cannot import "node:fs"');
    }),
  );
});

describe("AI.CodeModeEffect", { tags: ["unit"] }, () => {
  it.effect("a module's default export is an Effect, which is run", () =>
    Effect.gen(function* () {
      const result = yield* run(
        AI.CodeModeEffect,
        [
          'import { Effect } from "effect";',
          "",
          "export default Effect.gen(function* () {",
          "  const { sum } = yield* tools.add({ a: 2, b: 3 });",
          "  return yield* tools.withdraw({ amount: 500 }).pipe(",
          '    Effect.catchTag("InsufficientFunds", (error) => Effect.succeed(error.balance + sum)),',
          "  );",
          "});",
        ].join("\n"),
      );
      expect(result).toEqual({ ok: true, value: 142, output: [] });
    }),
  );

  it.effect("the body of Effect.gen still runs", () =>
    Effect.gen(function* () {
      const result = yield* run(
        AI.CodeModeEffect,
        "const { sum } = yield* tools.add({ a: 2, b: 3 });\nreturn sum;",
      );
      expect(result).toEqual({ ok: true, value: 5, output: [] });
    }),
  );

  it.effect("a program may run its Effect itself", () =>
    Effect.gen(function* () {
      const result = yield* run(
        AI.CodeModeEffect,
        [
          "const program = Effect.map(tools.add({ a: 2, b: 3 }), ({ sum }) => sum);",
          "export default await Effect.runPromise(program);",
        ].join("\n"),
      );
      expect(result).toEqual({ ok: true, value: 5, output: [] });
    }),
  );

  it.effect("a failure nothing handles fails the program with its tag", () =>
    Effect.gen(function* () {
      const result = yield* run(
        AI.CodeModeEffect,
        "export default tools.withdraw({ amount: 500 });",
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toContain("InsufficientFunds");
    }),
  );
});
