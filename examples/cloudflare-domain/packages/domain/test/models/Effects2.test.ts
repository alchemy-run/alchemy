import type * as Value from "@alchemy.run/domain/Prove/internal/Value";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { arr, lib, make, num, obj, outcome, ran, str } from "./harness.ts";

const run = (key: string, args: ReadonlyArray<Value.V>) =>
  outcome(Effect.flatMap(make(key, args), ran));

it.effect(
  "an effect's handlers, fallbacks and options, given errors with no tag and functions of the library",
  () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const self = yield* make("effect/Effect:succeed", [num(1)]);
      const failing = () => make("effect/Effect:fail", [num(2)]);
      const succeed = lib("effect/Effect:succeed");
      const no = lib("effect/Function:constFalse");
      seen.push(
        yield* run("effect/Effect:catchTag", [yield* failing(), str("X"), succeed, succeed]),
      );
      seen.push(yield* run("effect/Effect:catchTags", [yield* failing(), obj({}), succeed]));
      seen.push(yield* run("effect/Effect:catchTags", [yield* failing(), obj({})]));
      seen.push(yield* run("effect/Effect:catchIf", [yield* failing(), no, succeed, succeed]));
      seen.push(
        yield* run("effect/Effect:tapErrorTag", [yield* failing(), arr(str("X")), succeed]),
      );
      seen.push(yield* run("effect/Effect:filterOrFail", [self, no]));
      seen.push(
        yield* run("effect/Effect:all", [
          obj({ x: self }),
          obj({ discard: { _tag: "Bool", value: true } as Value.V }),
        ]),
      );
      seen.push(yield* run("effect/Effect:withSpanScoped", [self, str("s")]));
      seen.push(yield* run("effect/Effect:withSpanScoped", [self]));
      for (const key of [
        "catch",
        "mapError",
        "orElseSucceed",
        "tapError",
        "filterOrElse",
        "when",
        "bind",
        "let",
        "option",
        "optionFromOptional",
      ])
        seen.push([key, yield* run(`effect/Effect:${key}`, [yield* failing()])]);
      expect(JSON.parse(JSON.stringify(seen))).toEqual([
        { _tag: "Num", value: 2 },
        { _tag: "Num", value: 2 },
        "Rejected",
        { _tag: "Num", value: 2 },
        "Rejected",
        "Rejected",
        { _tag: "Undef" },
        "calls Effect.withSpanScoped outside Effect.scoped",
        "calls Effect.withSpanScoped outside Effect.scoped",
        ["catch", { _tag: "Native", name: "Effect.catch" }],
        ["mapError", { _tag: "Native", name: "Effect.mapError" }],
        ["orElseSucceed", { _tag: "Native", name: "Effect.orElseSucceed" }],
        ["tapError", { _tag: "Native", name: "Effect.tapError" }],
        ["filterOrElse", "Effect.filterOrElse is called in a way the prover has no model for"],
        ["when", { _tag: "Native", name: "Effect.when" }],
        ["bind", "Effect.bind is called in a way the prover has no model for"],
        ["let", "Effect.let is called in a way the prover has no model for"],
        [
          "option",
          {
            _tag: "Obj",
            fields: { _tag: { _tag: "Str", value: "None" } },
            brand: { kind: "Option" },
          },
        ],
        [
          "optionFromOptional",
          "calls Effect.optionFromOptional, which the prover has no model for",
        ],
      ]);
    }),
);
