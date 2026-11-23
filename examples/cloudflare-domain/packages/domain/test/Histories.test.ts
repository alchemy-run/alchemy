import { Story } from "@alchemy.run/domain/Story";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Careless,
  Forgetful,
  Generous,
  Lossy,
  LossyLive,
  Safe,
  SafeApi,
  SafeLive,
} from "./fixtures/Safe.model.ts";

const source = new URL("./fixtures/Safe.model.ts", import.meta.url);
const options = { apis: [SafeApi], source, depth: 3, walks: { count: 0 } } as const;

const standings = (report: Verify.Report) =>
  Object.fromEntries(report.changes.map((change) => [change.name, change.standing]));

it.effect(
  "a model's rewrites and compactions are proved, and run in every sequence",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Safe, {
        ...options,
        story: Story.make(Safe, { layer: SafeLive }),
      });
      expect(standings(report)).toEqual({
        BringForward: "proved",
        ForgetOwner: "proved",
        // Built after the compaction, each view holds what it does built from the events.
        "Holding.BringForward": "checked",
        "Reserves.BringForward": "checked",
        // The rewrite's handler for the roll-up says what its handler for the event does.
        "ForgetOwner.BringForward": "checked",
      });
      expect(report.histories).toBeGreaterThan(0);
      expect(Verify.render(report)).toContain("Rewrites and compactions");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a view that reads a roll-up as less than its events is shown the sequence",
  () =>
    Effect.gen(function* () {
      const story = Story.make(Forgetful, { layer: SafeLive });
      const failed = yield* Verify.model(Forgetful, { ...options, story }).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      const activity = failed.report.changes.find(
        (change) => change.name === "Activity.BringForward",
      )!;
      expect(activity.standing).toBe("broken");
      expect(activity.broken!.shown).toContain('{"payments":0}');
      expect(activity.broken!.shown).toContain('{"payments":1}');
      expect(activity.broken!.script).toContain("Story.compact(Coffer.ref(");
      // The owner's view says the same either way.
      expect(standings(failed.report)["Holding.BringForward"]).toBe("checked");
      // Said to be on purpose, it passes.
      const allowed = yield* Verify.model(Forgetful, {
        ...options,
        story,
        allow: { lossy: ["Activity.BringForward"] },
      });
      expect(standings(allowed)["Activity.BringForward"]).toBe("allowed");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a rewrite that breaks an invariant is shown the sequence it breaks it after",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.model(Careless, {
        ...options,
        story: Story.make(Careless, {}),
      }).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      const drop = failed.report.changes.find((change) => change.name === "DropDeposits")!;
      expect(drop.standing).toBe("broken");
      // A deposit, a withdrawal it paid for, and then the deposit is gone.
      expect(drop.broken!.shown).toContain("NeverOverdrawn");
      expect(drop.broken!.script).toContain("new Deposit(");
      expect(drop.broken!.script).toContain("new Withdraw(");
      expect(drop.broken!.script).toContain("Story.rewrite(Coffer.ref(");
      expect(failed.message).toContain("As a story, to keep as a test:");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a rewrite no proof covers is checked in every sequence",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Generous, {
        ...options,
        story: Story.make(Generous, {}),
      });
      const double = report.changes.find((change) => change.name === "DoubleDeposits")!;
      expect(double.standing).toBe("checked");
      expect(double.runs).toBeGreaterThan(0);
      expect(double.unproved).toContain("NeverOverdrawn");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "a roll-up that loses state is refused in a sequence, and the proof says which state",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.model(Lossy, {
        ...options,
        story: Story.make(Lossy, { layer: LossyLive }),
      }).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      if (failed._tag !== "NotVerified") return;
      const sum = failed.report.changes.find((change) => change.name === "SumUp")!;
      expect(sum.standing).toBe("broken");
      expect(sum.broken!.shown).toContain("would change the state");
      expect(sum.unproved).toContain("deposits: 1");
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "without a story runner, what is not proved is not looked at",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Generous, options);
      expect(standings(report)).toEqual({ DoubleDeposits: "unseen" });
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
