import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import { Feed } from "./fixtures/Feed.aggregate.ts";
import { Fog } from "./fixtures/Fog.aggregate.ts";
import { Lathe } from "./fixtures/Lathe.aggregate.ts";
import { Ledger } from "./fixtures/Ledger.aggregate.ts";
import { Parcel } from "./fixtures/Parcel.aggregate.ts";
import { Roster } from "./fixtures/Roster.aggregate.ts";
import { Shelf } from "./fixtures/Shelf.aggregate.ts";

// What rules and handlers are written with, of Effect's own library: effects
// and their failures, `Result`, decimals, hash sets and maps, streams, and
// the functions of arrays, numbers and strings. Each is read as what it does,
// and each path the prover reads is run on the real code and has to agree.

const source = (name: string) => ({
  source: new URL(`./fixtures/${name}.aggregate.ts`, import.meta.url),
});

const verdictsOf = (report: Prove.Report, rule: string) =>
  Object.fromEntries(
    [...report.invariants, ...report.transitions]
      .find((entry) => entry.name === rule)!
      .commands.map((command) => [command.command, command.verdict]),
  );

const rulesOf = (report: Prove.Report) =>
  [...report.invariants, ...report.transitions].map((rule) => rule.name);

/** Every path was run on the real code, and the real code did what the prover read. */
const agrees = (report: Prove.Report) => {
  expect(report.agreement.differs).toEqual([]);
  expect(report.agreement.uncompared).toBe(0);
  expect(report.agreement.compared).toBeGreaterThan(0);
  expect(report.unread).toEqual([]);
};

const bounded = (list: string) => ({
  _tag: "Bounded",
  reason: expect.stringContaining(`${list} was tried with up to 2 items`),
});

it.effect(
  "a handler written as an effect is read: its failures caught, mapped and turned into rejections",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Parcel, source("Parcel"));
      for (const rule of rulesOf(report)) {
        const verdicts = verdictsOf(report, rule);
        // `Effect.forEach`, `Effect.reduce`, `Effect.all` and `Effect.fromResult`, over a list of items.
        expect(verdicts.Pack).toMatchObject(bounded("command.items"));
        // `Effect.filterOrFail`, `Effect.zip` and `Effect.catchTag`, on an error of `Data.TaggedError`.
        expect(verdicts.Send).toEqual({ _tag: "Proved" });
        // `Option.gen`, over `Option.liftPredicate`.
        expect(verdicts.Return).toEqual({ _tag: "Proved" });
      }
      agrees(report);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "money in decimals is counted exactly, and a rule it breaks is found",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Ledger, source("Ledger"));
      // A tenth of a charge, summed: exact in a decimal, and in the solver.
      expect(verdictsOf(report, "TheFeesAreATenthOfTheCharges")).toEqual({
        Charge: { _tag: "Proved" },
        Refund: { _tag: "Proved" },
        Waive: { _tag: "Proved" },
      });
      // `BigDecimal.min` keeps a refund within what is left of the charges.
      expect(verdictsOf(report, "NeverRefundedMoreThanCharged").Refund).toEqual({
        _tag: "Proved",
      });
      const verdict = verdictsOf(report, "NothingRefundedBelowZero").Waive;
      expect(verdict).toMatchObject({ _tag: "Violated" });
      if (verdict?._tag !== "Violated") return;
      // The counterexample is real decimals, which the real code was run on.
      const { command, after } = verdict.counterexample as unknown as {
        readonly command: { readonly amount: BigDecimal.BigDecimal };
        readonly after: { readonly refunded: BigDecimal.BigDecimal };
      };
      // The schema's bound on the amount is read: the solver never offers one it refuses.
      expect(BigDecimal.isPositive(command.amount)).toBe(true);
      expect(BigDecimal.isNegative(after.refunded)).toBe(true);
      agrees(report);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a hash set and a hash map are read, and a member left with points is found",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Roster, source("Roster"));
      // Sets and maps of up to two items were tried, as a list is.
      expect(verdictsOf(report, "NeverMoreThanTheSeats").Join).toMatchObject(
        bounded("state.members"),
      );
      // `HashMap.reduce` reads the points in order: every order is a path, and the sum is the same in each.
      expect(verdictsOf(report, "TheTotalIsTheSumOfThePoints").Leave).toMatchObject(
        bounded("state.points"),
      );
      const verdict = verdictsOf(report, "OnlyAMemberHasPoints").Drop;
      expect(verdict).toMatchObject({ _tag: "Violated" });
      if (verdict?._tag !== "Violated") return;
      const { state, command, after } = verdict.counterexample as unknown as {
        readonly state: { readonly members: HashSet.HashSet<string> };
        readonly command: { readonly person: string };
        readonly after: {
          readonly members: HashSet.HashSet<string>;
          readonly points: HashMap.HashMap<string, number>;
        };
      };
      expect(HashSet.has(state.members, command.person)).toBe(true);
      expect(HashSet.has(after.members, command.person)).toBe(false);
      expect(HashMap.has(after.points, command.person)).toBe(true);
      // `Lead` takes the first member the set gives. Which one that is, is the order of
      // their hashes: the rule holds in every order, and a path whose order the real set
      // does not give is left uncompared, never said to differ.
      expect(verdictsOf(report, "ALeadIsAMember").Lead).toMatchObject(bounded("state.members"));
      expect(report.agreement.differs).toEqual([]);
      // Those paths are counted apart from ones whose inputs could not be built, and said so.
      expect(report.agreement.unordered).toBeGreaterThan(0);
      expect(report.agreement.uncompared).toBe(report.agreement.unordered);
      expect(Prove.agreed(report.agreement)).toContain(
        `${report.agreement.unordered} take the items of a hash set or a hash map in an order the real one does not give`,
      );
      expect(Prove.agreed(report.agreement)).not.toContain("cannot build");
      // The lead is chosen only by the commands and rules that read it.
      expect(report.agreement.compared).toBeGreaterThan(50);
      expect(report.unread).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);

it.effect(
  "a stream is read as it runs: a step that stops early runs no effect after it",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Feed, source("Feed"));
      for (const rule of rulesOf(report)) {
        const verdicts = verdictsOf(report, rule);
        // `filter`, `mapEffect`, `take`, `runCollect`, `runFold`, `scan` and `runLast`.
        expect(verdicts.Record).toMatchObject(bounded("command.readings"));
        // `mapEffect` then `runHead`: only the first reading is checked, so a faulty one
        // after it does not reject the command. Read otherwise, the real code would differ.
        expect(verdicts.Sample).toMatchObject(bounded("command.readings"));
        // `Stream.iterate` never ends, and `take` cuts it.
        expect(verdicts.Skip).toEqual({ _tag: "Proved" });
        // A count an input decides, held between 1 and 3: each count is a path.
        expect(verdicts.Pad).toEqual({ _tag: "Proved" });
      }
      agrees(report);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "rules written with the functions of arrays, numbers, strings and orders are proved",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Shelf, source("Shelf"));
      expect(rulesOf(report)).toEqual([
        "TheWorthIsWhatTheLinesAreWorth",
        "NoSkuTwice",
        "NothingDearerThanTheDearest",
        "EverySkuIsOne",
        "AClearChangesNoPrice",
      ]);
      for (const rule of rulesOf(report))
        for (const verdict of Object.values(verdictsOf(report, rule)))
          expect(verdict).toMatchObject(bounded("state.lines"));
      agrees(report);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "classes a file exports, request contexts and streams of several chunks agree with the real code",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Lathe, source("Lathe"));
      for (const command of report.commands)
        expect([command.command, command.schema._tag]).toEqual([
          command.command,
          expect.stringMatching(/^(Proved|Bounded)$/),
        ]);
      expect(report.commands.map((command) => command.command)).toEqual([
        "Figure",
        "Letter",
        "Choose",
        "Gather",
        "Time",
        "Cell",
        "Act",
        "Flow",
        "Build",
        "Long",
      ]);
      agrees(report);
      expect(report.agreement.compared).toBeGreaterThan(60);
    }).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);

it.effect(
  "what is not read says why",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Fog, source("Fog"));
      expect(
        Object.fromEntries(
          Object.entries(verdictsOf(report, "NeverBelowZero")).map(([command, verdict]) => [
            command,
            verdict._tag === "NotTranslated" ? verdict.reason : verdict._tag,
          ]),
        ),
      ).toEqual({
        Race: "calls Stream.toAsyncIterable, which gives or goes over an async iterable, whose values come as promises",
        Share:
          "BigDecimal.divide divides decimals an input holds, which BigDecimal rounds and the prover does not",
        Walk: "reads the 5 items of a HashSet in order, which is the order of their hashes: the prover reads up to 4 in every order",
        Rank: "orders strings an input holds, which the prover does not translate",
        Unwrap: "yields a value the prover has no model for",
        Roll: "draws a random number with no seed: no two runs draw the same",
        Spin: "runs a stream that has not ended after 10000 items",
        Turn: "calls Array.rotate, which the prover has no model for",
        // Each of these was checked against the package: none is a function of the command alone.
        Remember: "calls Cache.get with a key the prover cannot see",
        Borrow: "calls Effect.timed, which measures with the machine's clock, not the handler's",
        Guard:
          "waits for permits of a Semaphore that nothing releases: the handler would never end",
        Configure: "calls Config.Int, which the prover has no model for",
        Link: "calls Graph.directed, which the prover has no model for",
        Tick: "calls Cron.next, which the prover has no model for",
        Before: "calls Cron.prev, which the prover has no model for",
        Often: "calls Cron.sequence, which the prover has no model for",
        Index: "calls Trie.insert, which the prover has no model for",
        Stretch: "calls repeat, which throws: RangeError: Invalid count value: -1",
        // Read, but not as the real code does it: nothing is proved of it.
        Shape: "Misread",
        // The library dies on a step that gives a plain value, and no `catch` handles that:
        // the command records nothing, so the rule holds of it.
        Plain: "Proved",
      });
      // The real code threw where the prover read on. That is reported, and does not stop the report.
      expect(report.agreement.differs).toEqual([
        expect.stringMatching(/^the prover read Shape .*, and the real code threw: TypeError/),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
