import * as Explore from "@alchemy.run/domain/Explore";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Mall, MallApi } from "./fixtures/Mall.model.ts";
import { Shop, ShopApi } from "./fixtures/Shop.model.ts";

// The explorer follows every kind of node a command's events reach: a view
// folds them, a policy reacts to what the view emits, and an external system
// answers the policy with whatever its schema allows.

const shop = Explore.report(Shop, {
  source: new URL("./fixtures/Shop.model.ts", import.meta.url),
  apis: [ShopApi],
  depth: 1,
}).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "a view is folded, and an invariant reads its state",
  () =>
    Effect.gen(function* () {
      const report = yield* shop;
      const rule = (name: string) => report.rules.find((rule) => rule.name === name);
      expect(report.views).toEqual(["Spend"]);
      expect(rule("SpendIsTheTotal")).toMatchObject({ broken: undefined });
      expect(rule("SpendIsTheTotal")?.states).toBeGreaterThan(0);
      // The explorer picks the total: the least one the view calls big.
      const big = rule("NoOrderIsBig")?.broken;
      expect(big?.map((step) => step.command)).toMatchObject([{ _tag: "Place", total: 100 }]);
      expect(report.disagreements).toEqual([]);
      expect(report.unread).toEqual([]);
    }),
  60_000,
);

it.effect(
  "a policy reacts to what a view emits, with the answer of an external system",
  () =>
    Effect.gen(function* () {
      const report = yield* shop;
      const rule = (name: string) => report.rules.find((rule) => rule.name === name);
      expect(report.followed).toEqual(["Review"]);
      expect(report.systems).toEqual(["Risk"]);
      expect(report.skipped).toEqual([]);
      // Nobody says what Risk answers: the explorer picks a score that holds the order.
      const held = rule("NoOrderIsHeld")?.broken;
      expect(held?.map((step) => [step.by, (step.command as { _tag: string })._tag])).toEqual([
        [undefined, "Place"],
        ["Review", "Hold"],
      ]);
      const [asked] = held?.[0]?.asked ?? [];
      expect(asked).toMatchObject({ by: "Review", call: "Risk.score", failed: false });
      expect((asked?.answer as { risk: number }).risk).toBeGreaterThan(0.5);
      expect(rule("OnlyBigOrdersAreHeld")).toMatchObject({ broken: undefined });
      expect(Explore.render(report)).toContain("↳ Review asks Risk.score  → { risk:");
    }),
  60_000,
);

it.effect(
  "an error an external system declares is an answer too",
  () =>
    Effect.gen(function* () {
      const report = yield* shop;
      // Review parks an order only when Risk is down.
      const parked = report.outcomes.find((outcome) => outcome.tag === "OrderParked")?.story;
      expect(parked?.[0]?.asked.at(-1)).toMatchObject({
        by: "Review",
        call: "Risk.score",
        answer: { _tag: "RiskUnavailable" },
        failed: true,
      });
      expect(report.failures).toEqual([]);
    }),
  60_000,
);

it.effect(
  "a view that routes its events, a view of a view and a projection are all followed",
  () =>
    Effect.gen(function* () {
      const report = yield* Explore.report(Mall, {
        source: new URL("./fixtures/Mall.model.ts", import.meta.url),
        apis: [MallApi],
        depth: 2,
      });
      expect(report.views).toEqual(["Takings", "Best"]);
      expect(report.projections).toEqual(["Receipts"]);
      expect(report.skipped).toEqual([]);
      const rule = (name: string) => report.rules.find((rule) => rule.name === name);
      // Takings is keyed by the shop an event names, not by the sale that recorded it.
      expect(rule("TakingsAreTheSales")).toMatchObject({ broken: undefined });
      // Best reads what Takings emits.
      expect(rule("BestIsAtLeastNow")).toMatchObject({ broken: undefined });
      // Receipts is given every Sold.
      expect(rule("EverySaleHasAReceipt")).toMatchObject({ broken: undefined });
      for (const name of ["TakingsAreTheSales", "BestIsAtLeastNow", "EverySaleHasAReceipt"])
        expect(rule(name)?.states).toBeGreaterThan(0);
      // A refund takes a shop's takings below its best.
      expect(
        rule("TakingsNeverFall")?.broken?.map((step) => (step.command as { _tag: string })._tag),
      ).toEqual(["Sell", "Refund"]);
      expect(report.disagreements).toEqual([]);
      expect(report.unread).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
