import * as Prove from "@alchemy.run/domain/Prove";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { idOf, isBlank } from "./fixtures/hash.ts";
import { Receipt } from "./fixtures/Receipt.aggregate.ts";
import { Stamp } from "./fixtures/Stamp.aggregate.ts";
import { Ticket } from "./fixtures/Ticket.aggregate.ts";

// What a handler calls that is not the model's own code: a helper the prover
// cannot read, a package of shared rules, and a schema's `make`.

const ticket = new URL("./fixtures/Ticket.aggregate.ts", import.meta.url);
const receipt = new URL("./fixtures/Receipt.aggregate.ts", import.meta.url);
const stamp = new URL("./fixtures/Stamp.aggregate.ts", import.meta.url);

const verdictsOf = (report: Prove.Report, rule: string) =>
  Object.fromEntries(
    [...report.invariants, ...report.transitions]
      .find((entry) => entry.name === rule)!
      .commands.map((command) => [command.command, command.verdict]),
  );

it.effect(
  "a ticket that hashes, calls a package and builds events with make is verified as it is",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.aggregate(Ticket);
      expect(report.rules.map((rule) => [rule.name, rule.standing])).toEqual([
        ["RunsAreCounted", "proved"],
        ["AClosedTicketStaysClosed", "proved"],
      ]);
      // Every path was run on the real code, the hash included.
      expect(report.proof.agreement).toMatchObject({ uncompared: 0, differs: [] });
      // The report says what the proof takes for granted of the hash.
      expect(report.proof.assumptions.at(-1)).toMatch(/idOf.* a pure function/);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a function from a package is read, and an event built with make is an event",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Ticket, { source: ticket });
      // `canClose` and `MAX_RUNS` come from `@bank/rules`; `Started.make({})` is `new Started({})`.
      expect(verdictsOf(report, "AClosedTicketStaysClosed")).toEqual({
        Start: { _tag: "Proved" },
        Close: { _tag: "Proved" },
      });
      // The package's function was read: nothing is taken for granted of it.
      expect(report.assumptions.join("\n")).not.toContain("canClose");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a helper the prover cannot read is the same value on the same arguments, and unknown inside",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Receipt, {
        source: receipt,
        opaque: [DateTime.formatIso],
      });
      // Two calls of `idOf` on one number: equal, whatever `idOf` does.
      expect(verdictsOf(report, "TheCopyIsTheId").Print).toEqual({ _tag: "Proved" });
      // A rule that reads into the result is not read, and the report says why `idOf` is not.
      expect(verdictsOf(report, "TheIdIsNeverEmpty").Print).toMatchObject({
        _tag: "NotTranslated",
        reason:
          "reads .length of what idOf returned, which the prover does not look inside: idOf reads .update of what createHash returned, which the prover does not look inside: createHash is a function of node:crypto, which is not code the prover reads",
      });
      expect(report.commands).toMatchObject([
        { command: "Print", schema: { _tag: "Proved" }, accepted: true },
      ]);
      // Each function the proof did not read is named in what it assumes.
      const assumed = report.assumptions.at(-1)!;
      for (const name of ["idOf", "isBlank", "formatIso"]) expect(assumed).toContain(name);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a counterexample past a helper the prover cannot read is run with the real one",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Receipt, {
        source: receipt,
        opaque: [DateTime.formatIso],
      });
      // `Print` records only a note the real `isBlank` refuses, so the solver's note is one.
      const verdict = verdictsOf(report, "NeverPrintedMoreThanTwice").Print;
      expect(verdict).toMatchObject({ _tag: "Violated" });
      if (verdict?._tag !== "Violated") return;
      const { command, after } = verdict.counterexample as {
        readonly command: { readonly note: string };
        readonly after: { readonly prints: number; readonly id: string; readonly copy: string };
      };
      expect(isBlank(command.note)).toBe(false);
      expect(after.prints).toBe(3);
      // The state after is the real code's: a real hash, and a real time as text.
      expect(after.id).toMatch(/^[0-9a-f]{64}$/);
      expect(after.copy).toBe(after.id);
      // Every path ran on the real code and did what the prover read.
      expect(report.agreement).toMatchObject({ uncompared: 0, differs: [] });
      expect(report.agreement.compared).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a function of a library the prover has no model for is not taken to be pure, until it is named",
  () =>
    Effect.gen(function* () {
      const read = yield* Prove.report(Receipt, { source: receipt });
      expect(verdictsOf(read, "TheCopyIsTheId").Print).toMatchObject({
        _tag: "NotTranslated",
        reason: "calls DateTime.formatIso, which the prover has no model for",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a helper that reads the clock or draws a random number is never taken to be pure",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Stamp, { source: stamp });
      // `Date` and `randomUUID` give a new value each call: the helpers that use them are not opaque.
      expect(verdictsOf(report, "TheCopyIsTheMark")).toMatchObject({
        Press: {
          _tag: "NotTranslated",
          reason: "refers to Date, which the prover cannot find",
        },
        Seal: {
          _tag: "NotTranslated",
          reason: "calls node:crypto.randomUUID, which the prover has no model for",
        },
      });
      expect(report.assumptions.join("\n")).not.toMatch(/a pure function/);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a function named as opaque is not read, though the prover could read it",
  () =>
    Effect.gen(function* () {
      const read = yield* Prove.report(Receipt, {
        source: receipt,
        opaque: [DateTime.formatIso, idOf, isBlank],
      });
      expect(verdictsOf(read, "TheIdIsNeverEmpty").Print).toMatchObject({
        _tag: "NotTranslated",
        reason:
          "reads .length of what idOf returned, which the prover does not look inside: idOf is opaque",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "an opaque function is known by its name when its file was loaded a second time",
  () =>
    Effect.gen(function* () {
      // Another load of the file: functions that are not the ones the prover's load exports.
      const copy = new URL("./fixtures/hash.ts?again", import.meta.url).href;
      const again = yield* Effect.promise(
        () => import(copy) as Promise<typeof import("./fixtures/hash.ts")>,
      );
      expect(again.idOf).not.toBe(idOf);
      const report = yield* Prove.report(Receipt, {
        source: receipt,
        opaque: [DateTime.formatIso, again.idOf],
      });
      expect(verdictsOf(report, "TheIdIsNeverEmpty").Print).toMatchObject({
        _tag: "NotTranslated",
        reason:
          "reads .length of what idOf returned, which the prover does not look inside: idOf is opaque",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
