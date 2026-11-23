import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Gate } from "./fixtures/Gate.aggregate.ts";
import {
  PayByCount,
  PayByLength,
  PayByRef,
  PayIfNamed,
  PayIfVersioned,
  PayOut,
  PayUnchecked,
  PayFromVersion,
} from "./fixtures/Refs.decision.ts";
import { countOf, nameOf, partsOf, versionOf } from "./fixtures/refs.ts";
import { Slug } from "./fixtures/Slug.aggregate.ts";

const source = (name: string) => ({
  source: new URL(`./fixtures/${name}.aggregate.ts`, import.meta.url),
});

const verdictsOf = (report: Prove.Report, rule: string) =>
  Object.fromEntries(
    [...report.invariants, ...report.transitions]
      .find((entry) => entry.name === rule)!
      .commands.map((command) => [command.command, command.verdict]),
  );

/** Every path was run on the real code, and the real code did what the prover read. */
const agrees = (report: Prove.Report) => {
  expect(report.agreement.differs).toEqual([]);
  expect(report.agreement.uncompared).toBe(0);
  expect(report.agreement.compared).toBeGreaterThan(0);
};

it.effect(
  "a tagged union's guards, isAnyOf, match and matchOrElse are read as tests of its tag",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Gate, source("Gate"));
      const verdicts = verdictsOf(report, "ClosedStaysClosed");
      for (const command of [
        "CloseByGuard",
        "CloseByTag",
        "CloseByAnyOf",
        "CloseByMatch",
        "CloseByOrElse",
      ])
        expect(verdicts[command], command).toEqual({ _tag: "Proved" });
      // `guards.Closed` lets a closed gate be held back: read, and found.
      expect(verdicts.Reopen).toMatchObject({ _tag: "Violated" });
      agrees(report);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a part of a string an input holds is read: before and after a separator, and the parts of a split",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Slug, source("Slug"));
      const name = verdictsOf(report, "NameHasNoAt");
      // `slice(0, indexOf(sep))`, guarded or not, `split(sep)[0]` and `const [name] = split(sep)`.
      for (const command of [
        "BySlice",
        "BySliceUnguarded",
        "BySplit",
        "ByFirstOfSplit",
        "ByFixedSlice",
      ])
        expect(name[command], command).toEqual({ _tag: "Proved" });
      // What is before the last `@` may hold another, and what is before `@@` may hold one.
      expect(name.ByLastIndex).toMatchObject({
        _tag: "Violated",
        counterexample: { after: { name: expect.stringContaining("@") } },
      });
      expect(name.ByWord).toMatchObject({ _tag: "Violated" });
      const version = verdictsOf(report, "VersionHasNoAt");
      // `slice(lastIndexOf(sep) + 1)`, `split(sep).at(-1)`, and after the first where it is the last.
      for (const command of ["AfterLastIndex", "AfterSplit", "AfterFirstOnly"])
        expect(version[command], command).toEqual({ _tag: "Proved" });
      expect(version.AfterSlice).toMatchObject({ _tag: "Violated" });
      // Code that counts the parts is read for a string of up to two separators.
      const bounded = {
        _tag: "Bounded",
        reason: 'command.ref.split("@") was tried with up to 3 items',
      };
      expect(verdictsOf(report, "AtLeastOnePart").CountParts).toEqual(bounded);
      expect(version.SecondPart).toEqual(bounded);
      agrees(report);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

const refs = new URL("./fixtures/Refs.decision.ts", import.meta.url);
const parsing = { source: refs, opaque: [nameOf, versionOf, partsOf, countOf] };

it.effect(
  "what an opaque function returns is the id, the Option, the number or the list the code uses it as",
  () =>
    Effect.gen(function* () {
      const proved = [{ name: "Account.NeverOverdrawn", verdict: { _tag: "Proved" } }];
      // A key is what `nameOf` gives; its result is compared with an id; `versionOf` gives an
      // `Option`, tested and then read; `countOf` gives a number.
      for (const decision of [PayByRef, PayIfNamed, PayIfVersioned, PayFromVersion, PayByCount]) {
        const report = yield* Prove.decisionReport(decision, parsing);
        expect(report.rules, report.command).toMatchObject(proved);
        expect(Prove.decisionProved(report)).toBe(true);
      }
      // `[...partsOf(cmd.to)]` is a list of ids: read for lists of up to two.
      const many = yield* Prove.decisionReport(PayOut, parsing);
      expect(many.rules[0]).toMatchObject({
        name: "Account.NeverOverdrawn",
        verdict: { _tag: "Bounded", reason: "what partsOf returned was tried with up to 2 items" },
      });
      // A decision that overdraws is found, on a command the real `nameOf` reads as the solver said.
      const broken = yield* Prove.decisionReport(PayUnchecked, parsing);
      const verdict = broken.rules[0]?.verdict;
      expect(verdict).toMatchObject({ _tag: "Violated" });
      if (verdict?._tag !== "Violated") return;
      const { after } = verdict.counterexample as { after: { from: { balance: number } } };
      expect(after.from.balance).toBeLessThan(0);
      // A rule that reads inside the result is still not read, and the report says why.
      const inside = yield* Prove.decisionReport(PayByLength, parsing);
      expect(inside.rules[0]?.verdict).toMatchObject({
        _tag: "NotTranslated",
        reason: expect.stringContaining("what nameOf returned"),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
