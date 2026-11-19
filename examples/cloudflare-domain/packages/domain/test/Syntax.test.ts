import * as Prove from "@alchemy.run/domain/Prove";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Basket } from "./fixtures/Basket.aggregate.ts";
import { Label } from "./fixtures/Label.aggregate.ts";
import { Locker } from "./fixtures/Locker.aggregate.ts";
import { Quota } from "./fixtures/Quota.aggregate.ts";
import { Sheet } from "./fixtures/Sheet.aggregate.ts";
import { Stack } from "./fixtures/Stack.aggregate.ts";
import { Stride } from "./fixtures/Stride.aggregate.ts";
import { Vault } from "./fixtures/Vault.aggregate.ts";
import { Wallet } from "./fixtures/Wallet.aggregate.ts";
import { Window } from "./fixtures/Window.aggregate.ts";

// What ordinary handlers are written with. Each of these once stopped the
// prover, or was passed over without a word.

const source = (name: string) => ({
  source: new URL(`./fixtures/${name}.aggregate.ts`, import.meta.url),
});

const verdictsOf = (report: Prove.Report, rule: string) =>
  Object.fromEntries(
    [...report.invariants, ...report.transitions]
      .find((entry) => entry.name === rule)!
      .commands.map((command) => [command.command, command.verdict]),
  );

it.effect(
  "a bucket of time, from Math.floor of a division, is proved",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.invariants(Window, source("Window"));
      expect(Prove.proved(report)).toBe(true);
      expect(report.transitions.map((transition) => transition.name)).toEqual([
        "TheBucketOnlyGrows",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "an Option field is read, and a command that breaks a rule through one is found",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Wallet, source("Wallet"));
      const verdicts = verdictsOf(report, "NeverNegative");
      expect(verdicts.Fund).toEqual({ _tag: "Proved" });
      expect(verdicts.Spend).toEqual({ _tag: "Proved" });
      expect(verdicts.Empty).toEqual({ _tag: "Proved" });
      expect(verdicts.Overspend).toMatchObject({ _tag: "Violated" });
      if (verdicts.Overspend?._tag !== "Violated") return;
      // The counterexample is a real Option, which the real code was run on.
      const { state, after } = verdicts.Overspend.counterexample as {
        readonly state: { readonly balance: Option.Option<number> };
        readonly after: { readonly balance: Option.Option<number> };
      };
      expect(Option.isSome(state.balance)).toBe(true);
      expect(Option.getOrThrow(after.balance)).toBeLessThan(0);
      expect(report.commands.every((command) => command.schema._tag === "Proved")).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a loop over a list is read, and proved only as far as the lists that were tried",
  () =>
    Effect.gen(function* () {
      const failed = yield* Prove.invariants(Basket, source("Basket")).pipe(Effect.flip);
      expect(failed._tag).toBe("InvariantsNotProved");
      if (failed._tag !== "InvariantsNotProved") return;
      // No list of up to two lines breaks either rule: a longer one was not looked at.
      for (const rule of ["TheTotalIsTheSumOfTheLines", "NeverFewerUnitsThanLines"])
        expect(verdictsOf(failed.report, rule).AddLines).toMatchObject({
          _tag: "Bounded",
          reason: expect.stringContaining("up to 2 items"),
        });
      expect(failed.message).toContain("proved for short lists only");
      // Verifying the aggregate passes, and says the rules are checked, not proved.
      const verified = yield* Verify.aggregate(Basket, { ...source("Basket"), depth: 2 });
      expect(verified.rules.map((rule) => rule.standing)).toEqual(["checked", "checked"]);
      expect(Verify.render(verified)).toContain("up to 2 items");
      // A rule that has to be proved fails the verification when it is only checked.
      const strict = yield* Verify.aggregate(Basket, {
        ...source("Basket"),
        depth: 2,
        require: { proved: ["TheTotalIsTheSumOfTheLines"] },
      }).pipe(Effect.flip);
      expect(strict._tag).toBe("NotVerified");
      expect(strict.message).toContain(
        "TheTotalIsTheSumOfTheLines is required to be proved, and is only checked",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a bigint is counted exactly, past what a number holds",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Vault, source("Vault"));
      const verdicts = verdictsOf(report, "NeverNegative");
      expect(verdicts.Store).toEqual({ _tag: "Proved" });
      expect(verdicts.Take).toEqual({ _tag: "Proved" });
      expect(verdicts.Halve).toEqual({ _tag: "Proved" });
      expect(verdicts.Charge).toMatchObject({
        _tag: "Violated",
        counterexample: { state: { cents: 0n }, after: { cents: -1n } },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a schema check the prover reads is proved kept, or shown broken",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Stride, source("Stride"));
      const schema = Object.fromEntries(
        report.commands.map((command) => [command.command, command.schema]),
      );
      // A multiple of five stays one after five more, and not after one more.
      expect(schema.Advance).toEqual({ _tag: "Proved" });
      expect(schema.Nudge).toMatchObject({ _tag: "Violated" });
      expect(report.unread).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a schema check the prover does not read is named, with the command that writes past it",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Label, source("Label"));
      expect(report.unread).toHaveLength(1);
      expect(report.unread[0]).toContain("state.code: ");
      expect(report.unread[0]).toContain("[A-Z]");
      // Rename writes the code, and Count leaves it as it was.
      expect(report.unkept).toHaveLength(1);
      expect(report.unkept).toEqual([
        "Rename writes state.code, which has to be a string matching the RegExp ^[A-Z]+$: the prover does not read that check, so it is not proved kept",
      ]);
      expect(Prove.render(report)).toContain("Schema checks not read");
      // Verifying the aggregate passes, and its report says what was not proved kept.
      const verified = yield* Verify.aggregate(Label, source("Label"));
      expect(Verify.render(verified)).toContain("Rename writes state.code");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a state without an optional field is one of the states a proof starts from",
  () =>
    Effect.gen(function* () {
      // The real code opens a quota that has no limit, which the rule says never happens.
      const report = yield* Prove.report(Quota, source("Quota"));
      expect(verdictsOf(report, "NeverOpen").Use).toMatchObject({
        _tag: "Violated",
        counterexample: { state: { open: false }, after: { open: true } },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "rest patterns, library helpers and locals that change are read",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Sheet, source("Sheet"));
      const tags = (verdicts: Record<string, Prove.Verdict>) =>
        Object.fromEntries(Object.entries(verdicts).map(([name, verdict]) => [name, verdict._tag]));
      // Tag and Tally read the tags, and were tried on a sheet with up to two.
      const expected = {
        Publish: "Proved",
        Discard: "Proved",
        Tag: "Bounded",
        Finish: "Proved",
        Tally: "Bounded",
      };
      expect(tags(verdictsOf(report, "CountsNeverNegative"))).toEqual(expected);
      expect(tags(verdictsOf(report, "LongNeverNegative"))).toEqual(expected);
      expect(
        Object.fromEntries(
          report.commands.map((command) => [command.command, command.schema._tag]),
        ),
      ).toEqual(expected);
      expect(report.commands.every((command) => command.accepted !== false)).toBe(true);
      expect(Prove.render(report)).not.toContain("may leave");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "code that changes a value it was given is not read as if it did not",
  () =>
    Effect.gen(function* () {
      const failed = yield* Prove.invariants(Stack, source("Stack")).pipe(Effect.flip);
      expect(failed._tag).toBe("InvariantsNotProved");
      if (failed._tag !== "InvariantsNotProved") return;
      expect(verdictsOf(failed.report, "NeverTooTall").Push).toMatchObject({
        _tag: "NotTranslated",
        reason: expect.stringContaining("pushes onto an array it was given"),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "handlers and rules written with effect/Match are read as branches on what they match",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Locker, source("Locker"));
      const negative = verdictsOf(report, "NeverNegative");
      // `Match.type` used as a function, `Match.valueTags`, an object pattern with a predicate.
      expect(negative.Open).toEqual({ _tag: "Proved" });
      expect(negative.Store).toEqual({ _tag: "Proved" });
      expect(negative.Take).toEqual({ _tag: "Proved" });
      expect(negative.Seal).toEqual({ _tag: "Proved" });
      // The command that never asks is found, and the real `Match` code breaks the rule on it.
      expect(negative.Grab).toMatchObject({ _tag: "Violated" });
      if (negative.Grab?._tag !== "Violated") return;
      const { state, after } = negative.Grab.counterexample as {
        readonly state: { readonly _tag: string; readonly held: number };
        readonly after: { readonly held: number };
      };
      expect(state._tag).toBe("Open");
      expect(after.held).toBeLessThan(0);
      // A rule that matches on the state before: no command changes a sealed locker.
      const sealed = verdictsOf(report, "ASealedLockerKeepsWhatItHolds");
      expect(Object.values(sealed).every((verdict) => verdict._tag === "Proved")).toBe(true);
      // Every command that can run was read: none stopped at code the prover has no model for.
      expect(report.commands.every((command) => command.schema._tag === "Proved")).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
