import * as Artifacts from "@/Artifacts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

// `Artifacts.cached` parks concurrent callers of the same key on the first
// caller's computation — e.g. a `Docker.Image` diff running `docker build`
// once for its own plan pass and once for a consumer resolving its output.
// Every waiter must learn how that computation ended, or a single failed
// build hangs the whole plan. Waits are bounded so a regression fails fast.
const withArtifacts = <A, E>(
  effect: Effect.Effect<A, E, Artifacts.Artifacts>,
) =>
  effect.pipe(
    Effect.provideService(
      Artifacts.Artifacts,
      Artifacts.makeScopedArtifacts(
        Artifacts.createArtifactStore(),
        "Test/Resource",
      ),
    ),
  );

describe("Artifacts.cached", { tags: ["unit", "local"] }, () => {
  it.live("runs once and shares a success with every waiter", () =>
    withArtifacts(
      Effect.gen(function* () {
        let runs = 0;
        const build = Artifacts.cached("build")(
          Effect.sleep("50 millis").pipe(
            Effect.map(() => {
              runs++;
              return "image-id";
            }),
          ),
        );
        const [a, b] = yield* Effect.all([build, build], {
          concurrency: "unbounded",
        });
        expect(a).toBe("image-id");
        expect(b).toBe("image-id");
        expect(runs).toBe(1);
      }),
    ),
  );

  it.live(
    "shares a failure with every waiter",
    () =>
      withArtifacts(
        Effect.gen(function* () {
          let runs = 0;
          const build = Artifacts.cached("build")(
            Effect.sleep("50 millis").pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  runs++;
                  return Effect.fail("docker build failed");
                }),
              ),
            ),
          );
          const [a, b] = yield* Effect.all(
            [build, build].map((call) =>
              call.pipe(Effect.timeout("2 seconds"), Effect.flip),
            ),
            { concurrency: "unbounded" },
          );
          expect(a).toBe("docker build failed");
          expect(b).toBe("docker build failed");
          expect(runs).toBe(1);
        }),
      ),
    { timeout: 5_000, retry: 0 },
  );

  it.live(
    "recomputes for a later caller after a failure",
    () =>
      withArtifacts(
        Effect.gen(function* () {
          let runs = 0;
          const build = Artifacts.cached("build")(
            Effect.suspend(() =>
              ++runs === 1
                ? Effect.fail("docker build failed")
                : Effect.succeed("image-id"),
            ),
          );
          const first = yield* Effect.exit(build);
          const second = yield* build.pipe(Effect.timeout("2 seconds"));
          expect(Exit.isFailure(first)).toBe(true);
          expect(second).toBe("image-id");
          expect(runs).toBe(2);
        }),
      ),
    { timeout: 5_000, retry: 0 },
  );

  it.live(
    "does not strand waiters when the first caller is interrupted",
    () =>
      withArtifacts(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const build = Artifacts.cached("build")(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          );
          const owner = yield* Effect.forkChild(build);
          yield* Deferred.await(started);
          const waiter = yield* Effect.forkChild(
            build.pipe(Effect.timeout("2 seconds")),
          );
          yield* Effect.sleep("10 millis");
          yield* Fiber.interrupt(owner);
          const exit = yield* Fiber.await(waiter);
          // The waiter sees the interruption rather than timing out.
          expect(
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
          ).toBe(true);
        }),
      ),
    { timeout: 5_000, retry: 0 },
  );
});
