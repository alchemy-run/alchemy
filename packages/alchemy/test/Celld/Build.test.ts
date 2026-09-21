import { workerBuildOptions } from "@/Celld/Build.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

it.effect(
  "Celld defaults to a single linked JavaScript bundle while preserving other build options",
  () =>
    Effect.gen(function* () {
      expect(yield* workerBuildOptions()).toEqual({
        output: { codeSplitting: false },
      });
      expect(yield* workerBuildOptions({ output: { minify: true } })).toEqual({
        output: { minify: true, codeSplitting: false },
      });
    }),
);
it.effect(
  "Celld rejects explicit unsupported code splitting before bundling",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        workerBuildOptions({ output: { codeSplitting: true } }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.reason).toBe("unsupported");
    }),
);
