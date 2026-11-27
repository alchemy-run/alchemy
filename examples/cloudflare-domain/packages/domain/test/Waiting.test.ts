import * as Explore from "@alchemy.run/domain/Explore";
import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Dispatch, Hold, Send, Sent } from "./fixtures/Dispatch.aggregate.ts";
import { Patient, PatientApi } from "./fixtures/Patient.model.ts";
import { Wary, WaryApi } from "./fixtures/Wary.model.ts";

// A handler that waits: it races two sleeps under a time limit, and how long
// each takes is a field of the command. The prover reads it on time that
// passes only when no fiber can run, and so does a prediction.

const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

const verdictsOf = (report: Prove.Report, rule: string) =>
  Object.fromEntries(
    report.transitions
      .find((entry) => entry.name === rule)!
      .commands.map((command) => [command.command, command.verdict]),
  );

it.effect(
  "a rule about a handler that races, sleeps and times out is proved for every duration",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Dispatch, {
        source: new URL("./fixtures/Dispatch.aggregate.ts", import.meta.url),
      });
      // The fast courier takes at most 20 milliseconds and the slow one at least 40.
      expect(verdictsOf(report, "TheSlowCourierNeverWins").Send).toEqual({ _tag: "Proved" });
      // A limit shorter than the fast courier leaves no answer, and the prover finds one.
      const verdict = verdictsOf(report, "SomeoneAlwaysAnswers").Send;
      expect(verdict).toMatchObject({ _tag: "Violated" });
      if (verdict?._tag !== "Violated") return;
      const { command } = verdict.counterexample as unknown as {
        readonly command: { readonly fast: number; readonly limit: number };
      };
      expect(command.limit * 2 + 1).toBeLessThan(command.fast * 2);
      // Every way through was run on the real handler, which did the same.
      expect(report.agreement).toMatchObject({ uncompared: 0, differs: [] });
      expect(report.agreement.compared).toBeGreaterThanOrEqual(2);
      // A wait for what nothing does is reported, with what it waits for.
      expect(verdictsOf(report, "TheSlowCourierNeverWins").Hold).toMatchObject({
        _tag: "NotTranslated",
        reason: "waits for a Deferred that nothing completes: the handler would never end",
      });
      expect(report.assumptions).toContain(
        "code between two waits takes no time: a time limit never stops a computation that does not wait",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it("a prediction of a handler that waits is made at once", () => {
  const started = performance.now();
  const send = (limit: number) =>
    Dispatch.predict({ by: "" }, new Send({ id: "d-1", fast: 5, slow: 20, limit }), { now });
  expect(send(40)).toMatchObject({ _tag: "Accepted", events: [new Sent({ by: "fast" })] });
  expect(send(2)).toMatchObject({ _tag: "Accepted", events: [new Sent({ by: "nobody" })] });
  // The handler would have waited 10 and 5 milliseconds.
  expect(performance.now() - started).toBeLessThan(5);
});

it("a prediction of a handler that never ends says so", () => {
  const prediction = Dispatch.predict({ by: "" }, new Hold({ id: "d-1" }), { now });
  expect(prediction._tag).toBe("Unpredictable");
  if (prediction._tag !== "Unpredictable") return;
  expect(String(prediction.cause)).toContain(
    "the handler waits for something outside it, which a prediction does not run",
  );
});

it.effect(
  "a policy that sleeps and races is followed by the search of the model",
  () =>
    Effect.gen(function* () {
      const report = yield* Explore.check(Patient, {
        source: new URL("./fixtures/Patient.model.ts", import.meta.url),
        apis: [PatientApi],
        depth: 1,
      });
      // The policy is read, not left out: it waits a second and then holds the order.
      expect(report.skipped).toEqual([]);
      expect(report.eventually).toEqual([
        expect.objectContaining({ name: "APlacedOrderIsHeld", broken: undefined }),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a policy's race of a wait the input decides is read on both sides of the limit",
  () =>
    Effect.gen(function* () {
      const report = yield* Explore.check(Wary, {
        source: new URL("./fixtures/Wary.model.ts", import.meta.url),
        apis: [WaryApi],
        depth: 1,
      }).pipe(Effect.flip);
      // Twice a whole number is never the odd limit: no two waits end at once, and the policy is read.
      expect(report.message).not.toContain("two waits end at the same moment");
      expect(report.message).toContain("Policies followed: Weigh");
      // A small order is held in time; a large one is not, and the search finds it.
      expect(report.message).toContain("Wary.APlacedOrderIsHeld does not hold");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
