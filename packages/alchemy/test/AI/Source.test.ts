/**
 * `AI.Source` — a term's file, resolved where `import.meta.url` is true
 * (the plan) and bound for where it is not (the bundled runtime). The
 * store goes through `RuntimeLiteral` rather than `RuntimeContext.set`
 * so `AI/Source.ts` never imports `Output` (see BrowserGraph.test.ts);
 * this pins the three postures `bindSource` must hold.
 */
import { bindSource, makeSource, renderSource } from "@/AI/Source.ts";
import * as Output from "@/Output.ts";
import {
  RuntimeContext,
  RuntimeLiteral,
  type BaseRuntimeContext,
} from "@/RuntimeContext.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** A runtime context over a plain env map, plus the literal seam the
 *  platform provides beside it — what `Platform.ts` wires at init. */
const stubRuntime = (env: Record<string, unknown>) => {
  const sets: Array<{ key: string; output: Output.Output }> = [];
  const ctx: BaseRuntimeContext = {
    Type: "Test",
    id: "test",
    env,
    get: <T>(key: string) => Effect.succeed(env[key] as T | undefined),
    set: (key, output) =>
      Effect.sync(() => {
        sets.push({ key, output });
        return key;
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(RuntimeContext, ctx),
    Layer.succeed(RuntimeLiteral, (key, value) =>
      ctx.set(key, Output.literal(value)),
    ),
  );
  return { layer, sets };
};

describe("AI.Source", () => {
  it.effect(
    "bare: no RuntimeContext, nothing is bound — the path still resolves",
    () =>
      Effect.gen(function* () {
        const source = makeSource(import.meta, "Skill", "Probe");
        expect(renderSource(source)).toBe("`Skill/Probe`");
        yield* bindSource(source);
        expect(source.path).toBe("test/AI/Source.test.ts");
        expect(renderSource(source)).toBe("`test/AI/Source.test.ts`");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "plan: the resolved path is stored under the term's key as a literal Output",
    () =>
      Effect.gen(function* () {
        const { layer, sets } = stubRuntime({});
        const source = makeSource(import.meta, "Skill", "Probe");
        yield* bindSource(source).pipe(Effect.provide(layer));
        expect(sets).toHaveLength(1);
        expect(sets[0]!.key).toBe("alchemy_source_Skill_Probe");
        expect(Output.isLiteralExpr(sets[0]!.output)).toBe(true);
        expect((sets[0]!.output as Output.LiteralExpr<string>).value).toBe(
          "test/AI/Source.test.ts",
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("runtime: no FileSystem, a bundle URL — the stored path wins", () =>
    Effect.gen(function* () {
      const { layer } = stubRuntime({
        alchemy_source_Skill_Probe: "src/coding/Engineer.ts",
      });
      // a bundled Worker's import.meta.url is not a file: URL
      const source = makeSource(
        "https://worker.example/bundle.js",
        "Skill",
        "Probe",
      );
      yield* bindSource(source).pipe(Effect.provide(layer));
      expect(source.path).toBe("src/coding/Engineer.ts");
      expect(renderSource(source)).toBe("`src/coding/Engineer.ts`");
    }),
  );
});
