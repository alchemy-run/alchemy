import { internalize } from "@/AlchemyControl/ControlEffect.ts";
import {
  ControlInternalError,
  InvalidControlInput,
} from "@/AlchemyControl/Surface.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

describe("ControlEffect", () => {
  it.effect("preserves expected failures", () =>
    Effect.gen(function* () {
      const expected = new InvalidControlInput({
        field: "stage",
        message: "A stage is required.",
      });
      const exit = yield* Effect.exit(internalize(Effect.fail(expected)));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toEqual(
          Option.some(expected),
        );
      }
    }),
  );

  it.effect(
    "preserves structurally tagged failures without constructor identity",
    () =>
      Effect.gen(function* () {
        const expected = {
          _tag: "InvalidControlInput" as const,
          field: "stage",
          message: "A stage is required.",
        };
        const exit = yield* Effect.exit(internalize(Effect.fail(expected)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.findErrorOption(exit.cause)).toEqual(
            Option.some(expected),
          );
        }
      }),
  );

  it.effect("converts defects to an internal failure", () =>
    Effect.gen(function* () {
      const defect = new Error("boom");
      const exit = yield* Effect.exit(
        internalize(
          Effect.sync(() => {
            throw defect;
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (
          Option.isSome(failure) &&
          failure.value instanceof ControlInternalError
        ) {
          expect(failure.value).toBeInstanceOf(ControlInternalError);
          expect(failure.value.message).toBe(
            "Unexpected failure in Alchemy control operation.",
          );
        }
      }
    }),
  );
});
