import { Story } from "@alchemy.run/domain/Story";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Chores, ChoresApi, GiveUpLive, ReminderLive } from "./fixtures/Chore.model.ts";
import { Counter } from "./fixtures/Counter.aggregate.ts";
import { Covered, Escrow } from "./fixtures/Escrow.aggregate.ts";
import {
  Order,
  Review,
  Risk,
  Hold,
  Park,
  Shop,
  ShopApi,
  ReviewLive,
} from "./fixtures/Shop.model.ts";

// One call: what can be proved is proved, the rest is searched, and every
// sequence found is run on the real model. Nobody says where the model's file
// is: it is found from this test's imports.

it.effect(
  "a model that keeps its rules is verified, and its sequences run on the real model",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Chores, {
        apis: [ChoresApi],
        depth: 1,
        story: Story.make(Chores, { layer: Layer.mergeAll(ReminderLive, GiveUpLive) }),
      });
      expect(report.rules).toMatchObject([
        { name: "Chores.EveryChoreIsDropped", kind: "eventually", standing: "checked" },
      ]);
      // Start, then the nudge an hour later, then the drop a day after that.
      expect(report.runs.length).toBeGreaterThan(0);
      expect(report.runs.filter((run) => run.failure !== undefined)).toEqual([]);
      expect(Verify.render(report)).toContain("✓ the model does what the explorer read in each");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

const shop = Story.make(Shop, { layer: ReviewLive, stub: [Risk] });

it.effect(
  "a broken rule fails with the sequence as a story to paste into a test",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.model(Shop, { apis: [ShopApi], depth: 1, story: shop }).pipe(
        Effect.flip,
      );
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      const standing = Object.fromEntries(
        failed.report.rules.map((rule) => [rule.name, rule.standing]),
      );
      expect(standing).toEqual({
        "Shop.OnlyBigOrdersAreHeld": "checked",
        "Shop.SpendIsTheTotal": "checked",
        "Shop.NoOrderIsBig": "broken",
        "Shop.NoOrderIsHeld": "broken",
      });
      // The sequence that holds an order, with the score the solver picked for Risk.
      expect(failed.message).toContain("✗ Shop.NoOrderIsHeld breaks");
      expect(failed.message).toContain("↳ Review asks Risk.score  → { risk:");
      expect(failed.message).toContain("As a story, to keep as a test:");
      expect(failed.message).toContain('Story.when(Order.ref("A"), new Place({ total: 100 })),');
      expect(failed.message).toContain("Story.call(Risk.score, {}),");
      expect(failed.message).toMatch(/Story\.succeed\(Risk\.score, \{ risk: [\d.]+ \}\),/);
      expect(failed.message).toContain(
        'Story.then(Order.ref("A"), new OrderPlaced({ total: 100 }), new OrderHeld({})),',
      );
      // Each of them ran on the real model, with Risk giving the answers the solver picked.
      expect(failed.report.runs.filter((run) => run.failure !== undefined)).toEqual([]);
      expect(failed.report.runs.map((run) => run.of)).toContain("breaks Shop.NoOrderIsHeld");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

/** A handler that is not the one the model's file declares: it holds every big order, whatever the score. */
const Strict = Review.toLayer(
  Effect.gen(function* () {
    const risk = yield* Risk;
    const orders = yield* Order;
    return Effect.fn(function* ({ source, event }) {
      const scored = yield* risk
        .score({ orderId: source.id, total: event.total })
        .pipe(Effect.catchTag("RiskUnavailable", () => Effect.succeed(undefined)));
      yield* orders
        .send(source, scored === undefined ? new Park({}) : new Hold({}))
        .pipe(Effect.catchTag("NotPlaced", () => Effect.void));
    });
  }),
);

it.effect(
  "a model that does not do what the explorer read is not verified",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.model(Shop, {
        apis: [ShopApi],
        depth: 1,
        story: Story.make(Shop, { layer: Strict, stub: [Risk] }),
      }).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      // The explorer read that a low score leaves the order alone. The real handler holds it.
      const wrong = failed.report.runs.filter((run) => run.failure !== undefined);
      expect(wrong.length).toBeGreaterThan(0);
      expect(wrong[0]?.failure).toContain("OrderHeld");
      expect(failed.message).toContain("✗ the model does something else in");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "an aggregate is proved and searched in one call",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.aggregate(Counter).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      expect(failed.message).toContain("✗ NeverGoesDown");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a rule that is true and not proved says which state the proof started from",
  () =>
    Effect.gen(function* () {
      // Reserve checks the balance, so no sequence overdraws. Nothing says the reserved
      // amount is covered, so the proof starts Capture from a state that is never reached.
      const report = yield* Verify.aggregate(Escrow);
      expect(report.rules).toMatchObject([
        {
          name: "NeverOverdrawn",
          standing: "checked",
          unproved: {
            command: "Capture",
            verdict: { _tag: "Violated", counterexample: { state: { balance: 0, reserved: 1 } } },
          },
        },
      ]);
      expect(Verify.render(report)).toContain(
        "not proved: Capture breaks it from { balance: 0, reserved: 1 }, a state the rules allow",
      );
      // With the rule that rules that state out written down, both are proved.
      const covered = yield* Verify.aggregate(Covered);
      expect(covered.rules.map((rule) => [rule.name, rule.standing])).toEqual([
        ["NeverOverdrawn", "proved"],
        ["ReservedIsCovered", "proved"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
