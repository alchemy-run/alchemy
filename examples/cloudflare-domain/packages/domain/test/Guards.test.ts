import * as Explore from "@alchemy.run/domain/Explore";
import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Bank } from "../src/Bank.model.ts";
import { CustomerApi } from "../src/CustomerApi.api.ts";
import { SupportApi } from "../src/SupportApi.api.ts";
import { Aside } from "./fixtures/Aside.aggregate.ts";
import { Deny } from "./fixtures/Deny.aggregate.ts";
import { Drift } from "./fixtures/Drift.aggregate.ts";
import { Gap } from "./fixtures/Gap.aggregate.ts";
import { Outlet, OutletApi } from "./fixtures/Outlet.model.ts";
import { Parity } from "./fixtures/Parity.aggregate.ts";
import { Shadow } from "./fixtures/Shadow.aggregate.ts";

// A pass has to mean the whole check was done. Each aggregate here once passed
// while part of it was not looked at.

const source = (name: string) => ({
  source: new URL(`./fixtures/${name}.aggregate.ts`, import.meta.url),
});

it.effect(
  "a command that takes the state out of its schema is not proved",
  () =>
    Effect.gen(function* () {
      // Copy keeps `b` at or above zero only while `a` is, and Lower takes `a` below.
      const failed = yield* Prove.invariants(Gap, source("Gap")).pipe(Effect.flip);
      expect(failed._tag).toBe("InvariantsNotProved");
      if (failed._tag !== "InvariantsNotProved") return;
      const lower = failed.report.commands.find((command) => command.command === "Lower");
      expect(lower?.schema).toMatchObject({
        _tag: "Violated",
        counterexample: { after: { a: -1, b: 0 } },
      });
      // No command breaks the invariant from a state in the schema, and still it is not proved.
      expect(Prove.proved(failed.report)).toBe(false);
      // The sequence the proof would have missed is the one the explorer finds.
      const broken = yield* Explore.check(Gap, { ...source("Gap"), depth: 2 }).pipe(Effect.flip);
      expect(broken._tag).toBe("InvariantBroken");
      if (broken._tag !== "InvariantBroken") return;
      expect(broken.report.invariants[0]?.broken?.map((step) => step.command)).toMatchObject([
        { _tag: "Lower" },
        { _tag: "Copy" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "code the explorer cannot read fails the check",
  () =>
    Effect.gen(function* () {
      const failed = yield* Explore.check(Parity, source("Parity")).pipe(Effect.flip);
      expect(failed._tag).toBe("Incomplete");
      if (failed._tag !== "Incomplete") return;
      expect(failed.report.unread).toHaveLength(1);
      expect(failed.report.states).toBe(0);
      expect(failed.reasons).toHaveLength(2);
      expect(failed.message).toContain("NotNegative was not looked at");
      const unproved = yield* Prove.invariants(Parity, source("Parity")).pipe(Effect.flip);
      expect(unproved._tag).toBe("InvariantsNotProved");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a command that is never accepted proves nothing",
  () =>
    Effect.gen(function* () {
      const unproved = yield* Prove.invariants(Deny, source("Deny")).pipe(Effect.flip);
      expect(unproved._tag).toBe("InvariantsNotProved");
      if (unproved._tag !== "InvariantsNotProved") return;
      expect(unproved.report.commands).toMatchObject([{ command: "Go", accepted: false }]);
      const failed = yield* Explore.check(Deny, source("Deny")).pipe(Effect.flip);
      expect(failed._tag).toBe("Incomplete");
      if (failed._tag !== "Incomplete") return;
      expect(failed.report.dead).toEqual(["Go"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "an event named like its aggregate is not read as the aggregate",
  () =>
    Effect.gen(function* () {
      const report = yield* Prove.report(Shadow, source("Shadow"));
      expect(report.invariants).toMatchObject([
        { name: "NotNegative", commands: [{ command: "Set", verdict: { _tag: "Violated" } }] },
      ]);
      const broken = yield* Explore.check(Shadow, source("Shadow")).pipe(Effect.flip);
      expect(broken._tag).toBe("InvariantBroken");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "invariants written outside the definition are refused, not passed over",
  () =>
    Effect.gen(function* () {
      const proving = yield* Prove.invariants(Aside, source("Aside")).pipe(Effect.flip);
      expect(proving._tag).toBe("ProveError");
      expect(proving.message).toContain("NotNegative");
      const exploring = yield* Explore.check(Aside, source("Aside")).pipe(Effect.flip);
      expect(exploring._tag).toBe("ExploreError");
      expect(exploring.message).toContain("NotNegative");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a policy the explorer leaves out fails the check until it is allowed by name",
  () =>
    Effect.gen(function* () {
      // Notify reacts to a view that routes its events, which the explorer does not fold.
      const options = {
        source: new URL("./fixtures/Outlet.model.ts", import.meta.url),
        apis: [OutletApi],
        depth: 1,
      };
      const failed = yield* Explore.check(Outlet, options).pipe(Effect.flip);
      expect(failed._tag).toBe("Incomplete");
      if (failed._tag !== "Incomplete") return;
      expect(failed.reasons).toHaveLength(1);
      expect(failed.reasons[0]).toContain("Notify");
      const report = yield* Explore.check(Outlet, { ...options, allow: { skipped: ["Notify"] } });
      expect(report.skipped.map((skipped) => skipped.policy)).toEqual(["Notify"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a search that stops at its budget fails the check until that is allowed",
  () =>
    Effect.gen(function* () {
      const options = {
        source: new URL("../src/Bank.model.ts", import.meta.url),
        apis: [CustomerApi, SupportApi],
        depth: 2,
        budget: 50,
      };
      const failed = yield* Explore.check(Bank, options).pipe(Effect.flip);
      expect(failed._tag).toBe("Incomplete");
      if (failed._tag !== "Incomplete") return;
      expect(failed.report.truncated).toBe(true);
      const report = yield* Explore.check(Bank, {
        ...options,
        allow: { truncated: true },
      });
      expect(report.truncated).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "arithmetic JavaScript rounds is not proved as if it were exact",
  () =>
    Effect.gen(function* () {
      // A tenth and two tenths are three tenths to a solver, and not to JavaScript:
      // the real aggregate records Rounded, which the rule says never happens.
      const failed = yield* Prove.invariants(Drift, source("Drift")).pipe(Effect.flip);
      expect(failed._tag).toBe("InvariantsNotProved");
      if (failed._tag !== "InvariantsNotProved") return;
      expect(failed.report.invariants[0]?.commands[0]?.verdict).toMatchObject({
        _tag: "NotTranslated",
        reason: expect.stringContaining("JavaScript rounds"),
      });
      const exploring = yield* Explore.check(Drift, source("Drift")).pipe(Effect.flip);
      expect(exploring._tag).toBe("Incomplete");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
