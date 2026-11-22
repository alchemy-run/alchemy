import * as Prove from "@alchemy.run/domain/Prove";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { idOf, isBlank } from "./fixtures/hash.ts";
import { Receipt } from "./fixtures/Receipt.aggregate.ts";
import { Ticket } from "./fixtures/Ticket.aggregate.ts";

// What a handler calls that is not the model's own code: a helper the prover
// cannot read, a package of shared rules, and a schema's `make`.

const ticket = new URL("./fixtures/Ticket.aggregate.ts", import.meta.url);
const receipt = new URL("./fixtures/Receipt.aggregate.ts", import.meta.url);

const verdictsOf = (report: Prove.Report, rule: string) =>
  Object.fromEntries(
    [...report.invariants, ...report.transitions]
      .find((entry) => entry.name === rule)!
      .commands.map((command) => [command.command, command.verdict]),
  );

it.effect(
  "a ticket that hashes, calls a package and builds events with make is verified",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.aggregate(Ticket, {
        packages: ["@bank/rules"],
        opaque: [idOf],
      });
      expect(report.rules.map((rule) => [rule.name, rule.standing])).toEqual([
        ["RunsAreCounted", "proved"],
        ["AClosedTicketStaysClosed", "proved"],
      ]);
      // Every path was run on the real code, the hash included.
      expect(report.proof.agreement).toMatchObject({ uncompared: 0, differs: [] });
      expect(report.proof.assumptions.at(-1)).toContain("idOf is a pure function");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a helper the prover cannot read stops every rule, until it is named as opaque",
  () =>
    Effect.gen(function* () {
      const read = yield* Prove.report(Ticket, { source: ticket, packages: ["@bank/rules"] });
      // The rule never looks at the hash, and is not proved for the command that makes one.
      expect(verdictsOf(read, "AClosedTicketStaysClosed")).toMatchObject({
        Start: {
          _tag: "NotTranslated",
          reason: "calls node:crypto.createHash, which the prover has no model for",
        },
        Close: { _tag: "Proved" },
      });
      const report = yield* Prove.invariants(Ticket, {
        source: ticket,
        packages: ["@bank/rules"],
        opaque: [idOf],
      });
      expect(Prove.proved(report)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a function from a package is read once the package is named",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Ticket, { source: ticket, opaque: [idOf] });
      const verdicts = verdictsOf(report, "AClosedTicketStaysClosed");
      expect(verdicts.Close).toMatchObject({
        _tag: "NotTranslated",
        reason: "calls @bank/rules/Ticket.canClose, which the prover has no model for",
      });
      // `Started.make({})` is an event, as `new Started({})` is.
      expect(verdicts.Start).toEqual({ _tag: "Proved" });

      const followed = yield* Prove.report(Ticket, {
        source: ticket,
        packages: ["@bank/rules"],
        opaque: [idOf],
      });
      expect(verdictsOf(followed, "AClosedTicketStaysClosed").Close).toEqual({ _tag: "Proved" });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "an opaque function is the same value on the same arguments, and unknown inside",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Receipt, {
        source: receipt,
        opaque: [idOf, isBlank, DateTime.formatIso],
      });
      // Two calls of `idOf` on one number: equal, whatever `idOf` does.
      expect(verdictsOf(report, "TheCopyIsTheId").Print).toEqual({ _tag: "Proved" });
      // A rule that reads into the result is not read, and the report names the function.
      expect(verdictsOf(report, "TheIdIsNeverEmpty").Print).toMatchObject({
        _tag: "NotTranslated",
        reason:
          "reads .length of what idOf returned, which the prover does not look inside: idOf is opaque",
      });
      expect(report.commands).toMatchObject([
        { command: "Print", schema: { _tag: "Proved" }, accepted: true },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a counterexample past an opaque function is run with the real one",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Receipt, {
        source: receipt,
        opaque: [idOf, isBlank, DateTime.formatIso],
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
  "an opaque function is known by its name when its file was loaded a second time",
  () =>
    Effect.gen(function* () {
      // Another load of the file: functions that are not the ones the prover's load exports.
      const copy = new URL("./fixtures/hash.ts?again", import.meta.url).href;
      const again = yield* Effect.promise(
        () => import(copy) as Promise<typeof import("./fixtures/hash.ts")>,
      );
      expect(again.idOf).not.toBe(idOf);
      const report = yield* Prove.invariants(Ticket, {
        source: ticket,
        packages: ["@bank/rules"],
        opaque: [again.idOf],
      });
      expect(Prove.proved(report)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
