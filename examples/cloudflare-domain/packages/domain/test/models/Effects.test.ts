import * as Value from "@alchemy.run/domain/Prove/internal/Value";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { arr, make, num, outcome, ran } from "./harness.ts";

const W = /is called in a way the prover has no model for/;
const run = (key: string, args: ReadonlyArray<Value.V>) =>
  outcome(Effect.flatMap(make(key, args), ran));

it.effect("an effect's functions given options they do not take are reported", () =>
  Effect.gen(function* () {
    const self = yield* make("effect/Effect:succeed", [num(1)]);
    const other = Value.obj({ other: Value.bool(true) });
    const items = arr(num(1));
    const f = yield* make("effect/Function:identity", []);
    expect(yield* run("effect/Effect:zip", [self, self, other])).toMatch(W);
    expect(yield* run("effect/Effect:zipWith", [self, self, f, other])).toMatch(W);
    expect(yield* run("effect/Effect:all", [Value.obj({ x: num(5) })])).toMatch(W);
    expect(yield* run("effect/Effect:all", [arr(num(5))])).toMatch(W);
    expect(yield* run("effect/Effect:all", [arr(self), other])).toMatch(W);
    for (const key of ["forEach", "filter", "findFirst", "partition"])
      expect(yield* run(`effect/Effect:${key}`, [items, f, other])).toMatch(
        key === "findFirst" ? /not a function/ : W,
      );
  }),
);
