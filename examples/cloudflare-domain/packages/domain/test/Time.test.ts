import * as Domain from "@alchemy.run/domain";
import * as Prove from "@alchemy.run/domain/Prove";
import { Story } from "@alchemy.run/domain/Story";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Late } from "./fixtures/Late.aggregate.ts";
import { Cut, Granted, Lapsed, Lease, Renew, Trim } from "./fixtures/Lease.aggregate.ts";

// Rules about time: written with `DateTime` and `Duration`, and with the
// clock, which inside `decide` is the time the command is handled at.

const source = (name: string) => ({
  source: new URL(`./fixtures/${name}.aggregate.ts`, import.meta.url),
});

const verdictsOf = (report: Prove.Report, rule: string) =>
  Object.fromEntries(
    report.transitions
      .find((entry) => entry.name === rule)!
      .commands.map((command) => [command.command, command.verdict]),
  );

const at = (iso: string) => DateTime.makeUnsafe(iso);

it.effect(
  "times are compared, moved and measured, and the clock in decide is the command's time",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Lease, source("Lease"));
      // `DateTime.distance` and `Duration.equals`, over a `DateTime.now` and an `addDuration`.
      expect(verdictsOf(report, "ARenewalAddsATerm")).toEqual({
        Grant: { _tag: "Proved" },
        Renew: { _tag: "Proved" },
        Trim: { _tag: "Proved" },
      });
      const verdicts = verdictsOf(report, "TheLeaseNeverShortens");
      // `Grant` adds days to the `now` it is given; `Renew` reads the clock for it.
      expect(verdicts.Grant).toEqual({ _tag: "Proved" });
      expect(verdicts.Renew).toEqual({ _tag: "Proved" });
      // `Trim` reads the clock in milliseconds, and takes an hour off a lease still running.
      expect(verdicts.Trim).toMatchObject({ _tag: "Violated" });
      if (verdicts.Trim?._tag !== "Violated") return;
      // The real code did the same at that time, whatever the time is today.
      const { state, now, after } = verdicts.Trim.counterexample as unknown as {
        readonly state: { readonly until: DateTime.Utc };
        readonly now: DateTime.Utc;
        readonly after: { readonly until: DateTime.Utc };
      };
      expect(DateTime.isGreaterThan(state.until, now)).toBe(true);
      expect(DateTime.distance(after.until, state.until)).toEqual(
        DateTime.distance(at("2026-01-01T00:00:00Z"), at("2026-01-01T01:00:00Z")),
      );
      // Every path ran on the real code and did what the prover read.
      expect(report.agreement).toMatchObject({ uncompared: 0, differs: [] });
      expect(report.agreement.compared).toBeGreaterThan(0);
      expect(report.unread).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a month is not read, and neither is the clock outside decide",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Late, source("Late"));
      expect(verdictsOf(report, "TheDueDateIsAhead")).toMatchObject({
        Push: {
          _tag: "NotTranslated",
          reason: "DateTime.add moves a time by months, which are not all the same length",
        },
        Hold: {
          _tag: "NotTranslated",
          reason:
            "reads the clock with DateTime.now outside decide, where the time is not an input",
        },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it("a predicted decision reads the clock as the time it is predicted at", () => {
  // The lease runs until after `now`, and ran out long before today.
  const prediction = Lease.predict({ until: at("2001-01-01T02:00:00Z") }, new Trim({ id: "l-1" }), {
    now: at("2001-01-01T00:00:00Z"),
  });
  expect(prediction).toMatchObject({
    _tag: "Accepted",
    events: [new Cut({ until: at("2001-01-01T01:00:00Z") })],
  });
});

class Leases extends Domain.Model("Leases", { aggregates: [Lease] }) {}

const story = Story.make(Leases);
const { clock, given, rejected, state, when } = Story;
const lease = Lease.ref("l-1");

it.effect("a command reads the clock as the time it is handled at", () =>
  story(
    // The lease is still running today, and has run out at the time of the commands.
    given(lease, new Granted({ until: at("2100-01-01T00:00:00Z") })),
    clock("2200-01-01T00:00:00Z"),
    when(new Renew({ id: lease.id })),
    rejected(new Lapsed()),
    when(new Trim({ id: lease.id })),
    state(lease, { until: at("2100-01-01T00:00:00Z") }),
  ),
);
