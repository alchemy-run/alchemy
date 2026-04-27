import * as Output from "@/Output";
import { inMemoryState } from "@/State/InMemoryState";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const provideState = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(inMemoryState()));

describe("Output.evaluate", () => {
  it.effect("preserves Redacted values at the top level", () =>
    provideState(
      Effect.gen(function* () {
        const secret = Redacted.make("hunter2");
        const result = yield* Output.evaluate(secret, {});
        expect(Redacted.isRedacted(result)).toBe(true);
        expect(Redacted.value(result as Redacted.Redacted<string>)).toBe(
          "hunter2",
        );
      }),
    ),
  );

  it.effect("preserves Redacted values nested inside an object", () =>
    provideState(
      Effect.gen(function* () {
        const secret = Redacted.make("hunter2");
        const result = yield* Output.evaluate({ value: secret, name: "x" }, {});
        expect(result.name).toBe("x");
        expect(Redacted.isRedacted(result.value)).toBe(true);
        expect(Redacted.value(result.value)).toBe("hunter2");
      }),
    ),
  );

  it.effect("preserves Redacted values nested inside an array", () =>
    provideState(
      Effect.gen(function* () {
        const secret = Redacted.make("hunter2");
        const [result] = yield* Output.evaluate([secret], {});
        expect(Redacted.isRedacted(result)).toBe(true);
        expect(Redacted.value(result)).toBe("hunter2");
      }),
    ),
  );
});
