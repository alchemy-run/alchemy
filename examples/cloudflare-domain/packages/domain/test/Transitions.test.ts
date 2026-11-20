import * as Explore from "@alchemy.run/domain/Explore";
import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Counter } from "./fixtures/Counter.aggregate.ts";

const source = { source: new URL("./fixtures/Counter.aggregate.ts", import.meta.url) };

it.effect(
  "a transition is proved for the commands that keep it, and broken by the one that does not",
  () =>
    Effect.gen(function* () {
      const failed = yield* Prove.invariants(Counter, source).pipe(Effect.flip);
      expect(failed._tag).toBe("InvariantsNotProved");
      if (failed._tag !== "InvariantsNotProved") return;
      const verdict = (name: string, command: string) =>
        failed.report.transitions
          .find((transition) => transition.name === name)
          ?.commands.find((c) => c.command === command)?.verdict;
      // Every state Clear leaves is one the invariant allows: only the step is wrong.
      expect(failed.report.invariants.map((i) => i.commands.map((c) => c.verdict._tag))).toEqual([
        ["Proved", "Proved"],
      ]);
      expect(verdict("NeverGoesDown", "Count")).toEqual({ _tag: "Proved" });
      expect(verdict("NeverGoesDown", "Clear")).toMatchObject({
        _tag: "Violated",
        counterexample: { state: { count: 1 }, after: { count: 0 } },
      });
      expect(verdict("CountsWhatItWasAsked", "Count")).toEqual({ _tag: "Proved" });
      expect(verdict("CountsWhatItWasAsked", "Clear")).toEqual({ _tag: "Proved" });
      // The transition reads who sent the command, and Clear never asks.
      expect(verdict("OnlyAnAdminClears", "Clear")).toMatchObject({
        _tag: "Violated",
        counterexample: { context: [{ name: "Operator", value: { admin: false } }] },
      });
      expect(failed.message).toContain("✗ NeverGoesDown");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "the explorer finds the shortest sequence that breaks a transition",
  () =>
    Effect.gen(function* () {
      const failed = yield* Explore.check(Counter, source).pipe(Effect.flip);
      expect(failed._tag).toBe("InvariantBroken");
      if (failed._tag !== "InvariantBroken" || "model" in failed.report) return;
      const rule = (name: string) =>
        failed.report.invariants.find((invariant) => invariant.name === name);
      expect(rule("NotNegative")).toMatchObject({ kind: "invariant", proved: true });
      expect(rule("CountsWhatItWasAsked")).toMatchObject({ kind: "transition", proved: true });
      // Clear does nothing on a new counter: the count has to go up first.
      expect(
        rule("NeverGoesDown")?.broken?.map((move) => (move.command as { _tag: string })._tag),
      ).toEqual(["Count", "Clear"]);
      expect(failed.message).toContain("✗ NeverGoesDown breaks");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
