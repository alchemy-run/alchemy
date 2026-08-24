import * as Operation from "@/AlchemyControl/Operation.ts";
import { InvalidControlInput } from "@/AlchemyControl/Surface.ts";
import { describe, expect, it } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

describe("AlchemyControl Operation", () => {
  it.effect("streams progress and returns the typed terminal result", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const operation = yield* Operation.make(
        (
          emit: (event: {
            readonly _tag: "Progress";
            readonly message: string;
          }) => Effect.Effect<void>,
        ) => emit({ _tag: "Progress", message: "working" }).pipe(Effect.as(42)),
      );

      const result = yield* Operation.run(operation, (event) =>
        Effect.sync(() => seen.push(event.message)),
      );

      expect(result).toBe(42);
      expect(seen).toEqual(["working"]);
    }),
  );

  it.effect("preserves expected failures in the stream error channel", () =>
    Effect.gen(function* () {
      const expected = new InvalidControlInput({
        field: "stage",
        message: "A stage is required.",
      });
      const operation = yield* Operation.make(() => Effect.fail(expected));
      const failure = yield* Operation.result(operation).pipe(Effect.flip);

      expect(failure).toBe(expected);
    }),
  );

  it.effect("interrupts the work when its consumer is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const operation = yield* Operation.make(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );
      const fiber = yield* Operation.result(operation).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(interrupted);
    }).pipe(Effect.scoped),
  );
});
