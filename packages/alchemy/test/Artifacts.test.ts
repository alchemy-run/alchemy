import { describe, expect, test } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Artifacts, cached, createArtifactStore, makeScopedArtifacts } from "@/Artifacts";

// `Docker.Image` wraps its build in `Artifacts.cached("build")` and builds during
// `diff`. If a cached effect fails or is interrupted, the placeholder stored while
// it ran must settle, or every later evaluation of the same artifact awaits
// forever. Every wait that could hang is guarded so a regression fails fast.

const guard = "2 seconds";

const run = <A, E>(effect: Effect.Effect<A, E, Artifacts>, service?: Artifacts["Service"]) =>
  Effect.runPromise(
    Effect.provideService(
      effect,
      Artifacts,
      service ?? makeScopedArtifacts(createArtifactStore(), "image"),
    ),
  );

describe("Artifacts.cached", { tags: ["unit", "local"] }, () => {
  test("a failed effect does not leave a hanging placeholder: a later call re-runs it and fails again", async () => {
    let runs = 0;
    const build = Effect.suspend(() => {
      runs += 1;
      return Effect.fail("boom");
    });
    const call = cached("build")(build).pipe(Effect.timeout(guard), Effect.flip);
    const errors = await run(
      Effect.gen(function* () {
        return [yield* call, yield* call];
      }),
    );
    expect(errors).toEqual(["boom", "boom"]);
    expect(runs).toBe(2);
  });

  test("a caller already waiting on a failing effect receives its failure", async () => {
    const base = makeScopedArtifacts(createArtifactStore(), "image");
    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      // The second caller is parked on the first caller's placeholder exactly when
      // its `get` returns an Effect; it awaits the placeholder with no yield point
      // in between.
      const service: Artifacts["Service"] = {
        ...base,
        get: <T>(key: string) =>
          base
            .get<T>(key)
            .pipe(
              Effect.tap((value) =>
                Effect.isEffect(value) ? Deferred.succeed(waiting, undefined) : Effect.void,
              ),
            ),
      };
      let secondRan = false;
      const first = yield* Effect.forkChild(
        cached("build")(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return yield* Effect.fail("boom");
          }),
        ).pipe(Effect.provideService(Artifacts, service)),
      );
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(
        cached("build")(
          Effect.sync(() => {
            secondRan = true;
            return "second";
          }),
        ).pipe(Effect.provideService(Artifacts, service)),
      );
      yield* Deferred.await(waiting);
      yield* Deferred.succeed(release, undefined);
      const firstError = yield* Fiber.join(first).pipe(Effect.timeout(guard), Effect.flip);
      const secondError = yield* Fiber.join(second).pipe(Effect.timeout(guard), Effect.flip);
      return { errors: [firstError, secondError], secondRan };
    });
    expect(await run(program)).toEqual({ errors: ["boom", "boom"], secondRan: false });
  });

  test("an interrupted effect does not leave later calls waiting", async () => {
    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        cached("build")(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      return yield* cached("build")(Effect.succeed("rebuilt")).pipe(Effect.timeout(guard));
    });
    expect(await run(program)).toBe("rebuilt");
  });

  test("a successful effect runs once and every caller gets its value", async () => {
    let runs = 0;
    const build = Effect.sync(() => {
      runs += 1;
      return "image";
    });
    const values = await run(
      Effect.gen(function* () {
        return [yield* cached("build")(build), yield* cached("build")(build)];
      }),
    );
    expect(values).toEqual(["image", "image"]);
    expect(runs).toBe(1);
  });
});
