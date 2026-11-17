import { describe, expect, it } from "@alchemy.run/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { Artifacts, cached, createArtifactStore, makeScopedArtifacts } from "@/Artifacts";

const withArtifacts = <A, E>(effect: Effect.Effect<A, E, Artifacts>) =>
  effect.pipe(Effect.provideService(Artifacts, makeScopedArtifacts(createArtifactStore(), "R")));

describe("Artifacts.cached", { tags: ["unit", "local"] }, () => {
  it.effect("runs the effect once and replays its success", () =>
    withArtifacts(
      Effect.gen(function* () {
        let runs = 0;
        const once = Effect.sync(() => ++runs).pipe(cached("k"));
        expect(yield* once).toBe(1);
        expect(yield* once).toBe(1);
        expect(runs).toBe(1);
      }),
    ),
  );

  // #2981: a failure left later callers awaiting a Deferred nobody completed.
  it.effect("retries after a failure instead of hanging", () =>
    withArtifacts(
      Effect.gen(function* () {
        let runs = 0;
        const once = Effect.suspend(() =>
          ++runs === 1 ? Effect.fail("boom") : Effect.succeed(runs),
        ).pipe(cached("k"));
        expect(yield* Effect.flip(once)).toBe("boom");
        expect(yield* once.pipe(Effect.timeoutOption("1 second"))).toEqual(Option.some(2));
      }),
    ),
  );

  it.effect("fails concurrent waiters when the running effect fails", () =>
    withArtifacts(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const once = Deferred.await(gate).pipe(Effect.andThen(Effect.fail("boom")), cached("k"));
        const first = yield* Effect.forkChild(Effect.flip(once));
        yield* Effect.yieldNow;
        const second = yield* Effect.forkChild(Effect.flip(once));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        expect(yield* Fiber.join(first)).toBe("boom");
        expect(yield* Fiber.join(second).pipe(Effect.timeoutOption("1 second"))).toEqual(
          Option.some("boom"),
        );
      }),
    ),
  );
});
