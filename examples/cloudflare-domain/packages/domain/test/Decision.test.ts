import * as Prove from "@alchemy.run/domain/Prove";
import { Story } from "@alchemy.run/domain/Story";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Charge, Move, Overdraw, Payout, Purse, Skim } from "./fixtures/Purse.decision.ts";
import { Leaky, LeakyApi, Tills, TillsApi, TitheLive } from "./fixtures/Till.model.ts";

// A decision is decided against several instances at once. It has to keep
// every rule of each aggregate it records on, and its own rules about them
// together.

const source = new URL("./fixtures/Purse.decision.ts", import.meta.url);

it.effect(
  "a decision that keeps each aggregate's rules and its own is proved",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.decision(Move, { source });
      expect(report.reads).toEqual([
        { name: "from", aggregate: "Purse" },
        { name: "to", aggregate: "Purse" },
      ]);
      expect(report.rules).toMatchObject([
        { name: "Purse.NeverNegative", kind: "invariant", verdict: { _tag: "Proved" } },
        { name: "MoneyIsConserved", kind: "decision", verdict: { _tag: "Proved" } },
      ]);
      expect(report.accepted).toBe(true);
      expect(Prove.renderDecision(report)).toContain("✓ Purse.NeverNegative");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a decision that breaks an aggregate's rule fails with the states and the command",
  () =>
    Effect.gen(function* () {
      const failed = yield* Prove.decision(Overdraw, { source }).pipe(Effect.flip);
      expect(failed._tag).toBe("DecisionNotProved");
      if (failed._tag !== "DecisionNotProved") return;
      const rule = failed.report.rules.find((rule) => rule.name === "Purse.NeverNegative");
      expect(rule?.verdict._tag).toBe("Violated");
      if (rule?.verdict._tag !== "Violated") return;
      // The real decide and evolve, run on the solver's values, leave a purse below zero.
      const after = rule.verdict.counterexample.after as { from: { balance: number } };
      expect(after.from.balance).toBeLessThan(0);
      expect(failed.message).toContain("✗ Purse.NeverNegative: violated");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a rule about the instances together is broken where each one's own rule holds",
  () =>
    Effect.gen(function* () {
      const failed = yield* Prove.decision(Skim, { source }).pipe(Effect.flip);
      expect(failed._tag).toBe("DecisionNotProved");
      if (failed._tag !== "DecisionNotProved") return;
      expect(failed.report.rules).toMatchObject([
        { name: "Purse.NeverNegative", verdict: { _tag: "Proved" } },
        { name: "MoneyIsConserved", verdict: { _tag: "Violated" } },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "two names that stand for one instance are tried as one",
  () =>
    Effect.gen(function* () {
      // Each purse can pay the fee. The same purse, named twice, pays it twice.
      const failed = yield* Prove.decision(Charge, { source }).pipe(Effect.flip);
      expect(failed._tag).toBe("DecisionNotProved");
      if (failed._tag !== "DecisionNotProved") return;
      const verdict = failed.report.rules[0]?.verdict;
      expect(verdict?._tag).toBe("Violated");
      if (verdict?._tag !== "Violated") return;
      const command = verdict.counterexample.command as { first: string; second: string };
      expect(command.first).toBe(command.second);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a decision over a list of instances is proved for short lists only",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.decisionReport(Payout, { source });
      expect(report.rules).toMatchObject([
        { name: "Purse.NeverNegative", verdict: { _tag: "Bounded" } },
      ]);
      expect(Prove.decisionProved(report)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "an aggregate that folds a decision's events is proved only with the decision",
  () =>
    Effect.gen(function* () {
      const alone = yield* Prove.invariants(Purse, { source }).pipe(Effect.flip);
      expect(alone._tag).toBe("InvariantsNotProved");
      if (alone._tag !== "InvariantsNotProved") return;
      expect(alone.report.outside).toEqual(["Sent", "Received"]);
      expect(alone.message).toContain("Purse folds Sent, Received");
      const report = yield* Prove.invariants(Purse, {
        source,
        decisions: [{ decision: Move, source }],
      });
      expect(report.outside).toEqual([]);
      expect(report.invariants).toMatchObject([
        {
          name: "NeverNegative",
          commands: [{ command: "MoveMoney", verdict: { _tag: "Proved" } }],
        },
      ]);
      const broken = yield* Prove.invariants(Purse, {
        source,
        decisions: [{ decision: Overdraw, source }],
      }).pipe(Effect.flip);
      expect(broken._tag).toBe("InvariantsNotProved");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

// In a model a decision is one step: every instance it records on changes at once,
// and the policies react to what it recorded on each.

const tills = Story.make(Tills, { layer: TitheLive });

it.effect(
  "a model's decision is proved, and runs as one step in every sequence",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Tills, {
        apis: [TillsApi],
        story: tills,
        walks: { count: 30 },
        // The till's rule has to hold for its own command and for the decision.
        require: { proved: ["Till.NeverNegative", "MoveMoney.MoneyIsConserved"] },
      });
      const standing = Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]));
      expect(standing).toEqual({
        "Till.NeverNegative": "proved",
        "MoveMoney.MoneyIsConserved": "proved",
        "Tills.HoldsWhatWasStocked": "checked",
      });
      expect(report.explored.decisions).toEqual(["MoveMoney"]);
      // The policy sends the decision's command: stocking a till moves a cent to the house.
      expect(report.explored.followed).toEqual(["Tithe"]);
      const moved = report.explored.outcomes.find(
        (outcome) => outcome.command === "MoveMoney" && outcome.tag === "Received",
      )?.story;
      // One step, whichever tills it names: what it recorded is kept instance by instance.
      expect(
        moved
          ?.at(-1)
          ?.recorded?.flatMap((part) =>
            part.events.map((event) => (event as { _tag: string })._tag),
          ),
      ).toEqual(["Sent", "Received"]);
      // Every sequence found ran on the real model, the decision included.
      expect(report.runs.length).toBeGreaterThan(0);
      expect(report.runs.filter((run) => run.failure !== undefined)).toEqual([]);
      expect(report.undone).toEqual([]);
      expect(Verify.render(report)).toContain("1 decision");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a decision that loses money fails with a story of the step",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.model(Leaky, {
        apis: [LeakyApi],
        story: Story.make(Leaky, {}),
        walks: { count: 30 },
      }).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      const standing = Object.fromEntries(
        failed.report.rules.map((rule) => [rule.name, rule.standing]),
      );
      expect(standing).toEqual({
        // Each till stays at or above zero: the decision checks the balance.
        "Till.NeverNegative": "proved",
        // The two together lose a cent, and so does the model.
        "SkimMoney.MoneyIsConserved": "broken",
        "Leaky.HoldsWhatWasStocked": "broken",
      });
      expect(failed.message).toContain("✗ SkimMoney.MoneyIsConserved breaks");
      // The story sends the decision's command, and expects what it recorded on each till.
      expect(failed.message).toMatch(
        /Story\.when\(new SkimMoney\(\{ from: "[^"]*", to: "[^"]*", amount: \d+ \}\)\),/,
      );
      expect(failed.message).toMatch(/Story\.then\(Till\.ref\("[^"]*"\), .*new Received\(/);
      expect(failed.report.runs.filter((run) => run.failure !== undefined)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "an aggregate a decision records on is not verified alone",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.aggregate(Purse).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      expect(failed.report.undone.join("\n")).toContain(
        "Purse folds Sent, Received, which a decision records",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
