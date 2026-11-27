import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  BringForward,
  DeleteCoffer,
  DoubleDeposits,
  DropDeposits,
  ForgetOwner,
  SumUp,
} from "./fixtures/Coffer.history.ts";

const source = new URL("./fixtures/Coffer.history.ts", import.meta.url);

it.effect(
  "a roll-up that carries the whole state is proved to lose nothing",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.compaction(BringForward, { source });
      expect(report.lossless._tag).toBe("Proved");
      expect(report.standing._tag).toBe("Proved");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a roll-up that leaves part of the state out is shown the state it loses",
  () =>
    Effect.gen(function* () {
      const failed = yield* Prove.compaction(SumUp, { source }).pipe(Effect.flip);
      expect(failed._tag).toBe("CompactionNotProved");
      if (failed._tag !== "CompactionNotProved") return;
      // From nothing, the deposits are not counted again.
      expect(failed.report.lossless._tag).toBe("Violated");
      if (failed.report.lossless._tag !== "Violated") return;
      const lost = failed.report.lossless.counterexample;
      expect((lost.state as { deposits: number }).deposits).toBeGreaterThan(0);
      expect((lost.after as { deposits: number }).deposits).toBe(0);
      // Onto the state it was made from, nothing changes: the instance itself would not notice.
      expect(failed.report.standing._tag).toBe("Proved");
      expect(failed.message).toContain("Folded from the initial state");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a rewrite that changes only what no rule speaks of is proved",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.rewrite(ForgetOwner, {
        source,
        compactions: [{ compaction: BringForward, source }],
      });
      expect(report.differs).toEqual(["owner"]);
      expect(Prove.rewriteProved(report)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a rewrite that removes what a later event relied on is shown the history it breaks",
  () =>
    Effect.gen(function* () {
      const failed = yield* Prove.rewrite(DropDeposits, {
        source,
        compactions: [{ compaction: BringForward, source }],
      }).pipe(Effect.flip);
      expect(failed._tag).toBe("RewriteNotProved");
      if (failed._tag !== "RewriteNotProved") return;
      expect(failed.report.differs).toEqual(["balance", "deposits"]);
      const overdrawn = failed.report.invariants.find((rule) => rule.name === "NeverOverdrawn")!;
      const withdraw = overdrawn.steps.find((step) => step.step === "Withdraw")!;
      // A withdrawal the recorded balance allowed, on a rewritten balance that has less. It is
      // two states and not a history, so it is not called a violation: a sequence shows one.
      expect(withdraw.verdict._tag).toBe("Unconfirmed");
      expect(failed.message).toContain("which breaks NeverOverdrawn");
      // Removing a deposit breaks nothing by itself.
      expect(overdrawn.steps.find((step) => step.step === "Deposit")!.verdict._tag).toBe("Proved");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a rewrite that only adds money is proved, though the balance differs",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.rewriteReport(DoubleDeposits, { source });
      expect(report.differs).toEqual(["balance"]);
      // A withdrawal is checked against a rewritten balance that may be anything the rules allow:
      // the proof cannot know it is larger, so it does not pass.
      const overdrawn = report.invariants.find((rule) => rule.name === "NeverOverdrawn")!;
      expect(overdrawn.steps.find((step) => step.step === "Deposit")!.verdict._tag).toBe("Proved");
      expect(overdrawn.steps.find((step) => step.step === "Withdraw")!.verdict._tag).not.toBe(
        "Proved",
      );
      // The coffer folds roll-ups no command records, and none was given.
      expect(report.outside).toEqual(["BroughtForward", "Summed"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a rewrite that removes the instance has nothing left to break",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.rewrite(DeleteCoffer, { source });
      expect(report.deletes).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
