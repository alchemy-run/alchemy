import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Defaults } from "./fixtures/Defaults.aggregate.ts";
import { NoteByField, NoteByKind } from "./fixtures/Pad.decision.ts";

const pad = { source: new URL("./fixtures/Pad.decision.ts", import.meta.url) };

it.effect(
  "a side of a test no inputs reach is not a path",
  () =>
    Effect.gen(function* () {
      // Twelve tests of one string: all false, or one of them true. Each for one instance and for two.
      const report = yield* Prove.decisionReport(NoteByKind, pad);
      expect(report.paths).toBe(26);
      expect(report.schema).toEqual({ _tag: "Proved" });
      expect(Prove.decisionProved(report)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a field read only for a default is one value, and no path each way",
  () =>
    Effect.gen(function* () {
      // Twelve optional fields, each with a default: one path for one instance, and one for two.
      const report = yield* Prove.decisionReport(NoteByField, pad);
      expect(report.paths).toBe(2);
      expect(report.schema).toEqual({ _tag: "Proved" });
      expect(Prove.decisionProved(report)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "the value is the field's where it holds one and the default where it does not, as the real code has it",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Defaults, {
        source: new URL("./fixtures/Defaults.aggregate.ts", import.meta.url),
      });
      const verdicts = (rule: string) =>
        Object.fromEntries(
          report.invariants
            .find((entry) => entry.name === rule)!
            .commands.map((command) => [command.command, command.verdict]),
        );
      const labelled = verdicts("Labelled");
      const sized = verdicts("Sized");
      const proved = { _tag: "Proved" };
      for (const command of [
        "Name",
        "Note",
        "NoteThrough",
        "NameTwice",
        "NameOrNote",
        "NameHeld",
        "NameTaken",
        "NameAssigned",
        "NoteMarked",
      ])
        expect(labelled[command], command).toEqual(proved);
      // The schema's check holds of a count that is there, and `null` is nothing.
      for (const command of ["Count", "Limit", "CountPlus"])
        expect(sized[command], command).toEqual(proved);
      // The field's own value is found where it breaks the rule: it is there, and empty.
      expect(labelled.Rename).toMatchObject({
        _tag: "Violated",
        counterexample: { command: { name: "" }, after: { label: "" } },
      });
      expect(sized.CountDown).toMatchObject({
        _tag: "Violated",
        counterexample: { command: { count: 0 }, after: { size: -1 } },
      });
      for (const command of ["NotePiped", "NoteMatched"]) {
        const verdict = labelled[command];
        expect(verdict, command).toMatchObject({ _tag: "Violated" });
        if (verdict?._tag !== "Violated") continue;
        const { command: found } = verdict.counterexample as { command: { note: unknown } };
        expect(found.note, command).toMatchObject({ _tag: "Some", value: "" });
      }
      // One path each. A field looked at after its default was taken is a choice then,
      // and so is the field a default reads.
      expect(
        Object.fromEntries(report.commands.map((command) => [command.command, command.paths])),
      ).toEqual({
        Name: 1,
        Rename: 1,
        Count: 1,
        CountDown: 1,
        Limit: 1,
        Note: 1,
        NotePiped: 1,
        NoteThrough: 1,
        NoteMatched: 1,
        NameTwice: 2,
        NameOrNote: 2,
        NameHeld: 1,
        NameTaken: 1,
        NameAssigned: 1,
        CountPlus: 1,
        NoteMarked: 1,
      });
      // Inputs of every path, run on the real `decide` and `evolve`: a field the solver says is there is given.
      expect(report.agreement.differs).toEqual([]);
      expect(report.agreement.uncompared).toBe(0);
      expect(report.agreement.compared).toBe(18);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
