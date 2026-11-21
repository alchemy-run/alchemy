import * as Prove from "@alchemy.run/domain/Prove";
import { Story } from "@alchemy.run/domain/Story";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Captured, Covered, Escrow, Paid, Reserved } from "./fixtures/Escrow.aggregate.ts";
import { Kiosk, KioskApi, Shut, ShutApi } from "./fixtures/Kiosk.model.ts";
import { Truck } from "./fixtures/Skew.aggregate.ts";

// What a pass rests on, and what keeps it: the prover's reading is held
// against the real code, a missing rule is found, what must be possible is
// reached, and a rule cannot be taken out or made to say less unseen.

/** Node's services, with `CI` as given: a lock file is written only outside it. */
const services = (ci: boolean, update = false) =>
  Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ CI: String(ci), UPDATE_VERIFY_LOCK: update ? "1" : "" }),
    ),
  );

const lockIn = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "verify-lock-" }), name);
});

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.flip);

it.effect(
  "every path the prover takes is run on the real code, and they agree",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.aggregate(Covered);
      // Pay, Reserve refused and accepted, and Capture with and without money reserved.
      expect(report.proof.agreement).toEqual({ compared: 5, uncompared: 0, differs: [] });
      expect(Verify.render(report)).toContain(
        "Agreed with the real code: inputs picked for each of 5 paths through the commands did what the prover read",
      );
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a rule proved from code the prover reads wrongly is not proved",
  () =>
    Effect.gen(function* () {
      // The file raises its limit as it loads. The prover reads the limit as written, and
      // proves a rule the real code breaks. Run on the real code, the two part ways.
      const proof = yield* Prove.report(Truck, {
        source: new URL("./fixtures/Skew.aggregate.ts", import.meta.url),
      });
      expect(proof.invariants[0]?.commands[0]?.verdict._tag).toBe("Misread");
      expect(proof.agreement.differs.length).toBeGreaterThan(0);
      expect(proof.agreement.differs[0]).toMatch(
        /^the prover read Load \{ .* \} on \{ held: \d+ \} as rejected with .*, and the real code records Loaded/,
      );
      expect(Prove.proved(proof)).toBe(false);
      expect(Prove.render(proof)).toContain("Load: read wrongly");
      // Three loads do not overload the truck, so the search breaks nothing: the proof is what fails.
      const error = yield* failure(Verify.aggregate(Truck));
      expect(error._tag).toBe("NotVerified");
      expect(error.message).toContain(
        "  ✓ NeverOverloaded\n      not proved for Load: the prover read",
      );
      expect(error.message).toMatch(/Not done\n(  ✗ .*\n)*  ✗ the prover read Load/);
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "where a proof fails from a state no sequence reaches, the invariant that rules it out is found",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.aggregate(Escrow);
      expect(report.rules).toMatchObject([
        {
          name: "NeverOverdrawn",
          standing: "checked",
          suggested: {
            name: "ReservedWithinBalance",
            source: "(hold) => hold.reserved <= hold.balance",
          },
        },
      ]);
      expect(Verify.render(report)).toContain(
        [
          "      No sequence that was run reaches that state, and none can.",
          "      Every command keeps this, and with it the rule is proved. Add it to the invariants:",
          "        ReservedWithinBalance: (hold) => hold.reserved <= hold.balance,",
        ].join("\n"),
      );
      // The aggregate with a rule of that kind written down is proved, and nothing more is suggested.
      const covered = yield* Verify.aggregate(Covered);
      expect(covered.rules.map((rule) => [rule.standing, rule.suggested])).toEqual([
        ["proved", undefined],
        ["proved", undefined],
      ]);
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "what a model says can happen is reached, by a sequence that runs on the real model",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Kiosk, {
        apis: [KioskApi],
        story: Story.make(Kiosk),
        walks: { count: 0 },
      });
      const rule = report.rules.find((rule) => rule.name === "Kiosk.SomethingIsSold");
      expect(rule).toMatchObject({ kind: "sometimes", standing: "reached" });
      expect(rule?.story?.map((step) => (step.command as { _tag: string })._tag)).toEqual([
        "Stock",
        "Sell",
      ]);
      expect(report.runs.find((run) => run.of === "reaches Kiosk.SomethingIsSold")).toMatchObject({
        failure: undefined,
      });
      expect(Verify.render(report)).toContain(
        [
          "Reached: a sequence of commands gets there",
          "  ✓ Kiosk.SomethingIsSold",
          '      1. Shelf "A" Stock { id: "A" }  → Stocked',
          '      2. Shelf "A" Sell { id: "A" }  → Sold',
        ].join("\n"),
      );
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a model that keeps its rules by doing nothing fails on what it says can happen",
  () =>
    Effect.gen(function* () {
      const error = yield* failure(Verify.model(Shut, { apis: [ShutApi], walks: { count: 20 } }));
      expect(error._tag).toBe("NotVerified");
      if (error._tag !== "NotVerified") return;
      expect(error.report.rules.find((rule) => rule.kind === "sometimes")).toMatchObject({
        name: "Shut.SomethingIsSold",
        standing: "unreached",
      });
      // Every other rule holds, and no command is one that never does anything: only
      // what must be possible says the model is wrong.
      expect(error.report.rules.filter((rule) => rule.standing === "broken")).toEqual([]);
      expect(error.report.undone).toEqual([
        "Shut.SomethingIsSold is never reached: no sequence of up to 2 commands, and no walk, gets there",
      ]);
    }).pipe(Effect.provide(services(false))),
  60_000,
);

const locked = (source: string) =>
  `${JSON.stringify(
    { version: 1, rules: { Escrow: { NeverOverdrawn: { kind: "invariant", source } } } },
    null,
    2,
  )}\n`;

it.effect(
  "the first run writes the lock, and a run that changes nothing leaves it alone",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      yield* Verify.aggregate(Escrow, { lock });
      const written = yield* fs.readFileString(lock);
      expect(written).toBe(locked("(hold) => hold.balance >= 0"));
      const before = yield* fs.stat(lock);
      yield* Verify.aggregate(Escrow, { lock });
      expect((yield* fs.stat(lock)).mtime).toEqual(before.mtime);
      // A second aggregate is kept beside the first.
      yield* Verify.aggregate(Covered, { lock });
      const both = JSON.parse(yield* fs.readFileString(lock)) as {
        readonly rules: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      };
      expect(Object.keys(both.rules)).toEqual(["Escrow", "Covered"]);
      expect(Object.keys(both.rules.Covered!)).toEqual(["NeverOverdrawn", "ReservedIsCovered"]);
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a rule that says less than the one locked fails, with a state that now passes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      // The rule was once that ten is always kept back.
      yield* fs.writeFileString(lock, locked("(hold) => hold.balance >= 10"));
      const error = yield* failure(Verify.aggregate(Escrow, { lock }));
      expect(error._tag).toBe("NotVerified");
      expect(error.message).toMatch(
        /✗ NeverOverdrawn says less than the rule locked in verify\.lock\.json: \{ balance: \d, reserved: -?\d+ \} passes it now, and the locked rule refuses it/,
      );
      expect(error.message).toContain(
        "to change a rule on purpose, run the test once with UPDATE_VERIFY_LOCK=1",
      );
      // The lock is as it was: a failing run does not relock.
      expect(yield* fs.readFileString(lock)).toBe(locked("(hold) => hold.balance >= 10"));
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a rule that says as much as the one locked passes, and replaces it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      // Written another way, and a rule that allowed more: neither is a loss.
      yield* fs.writeFileString(lock, locked("(hold) =>\n  0 <= hold.balance"));
      yield* Verify.aggregate(Escrow, { lock });
      expect(yield* fs.readFileString(lock)).toBe(locked("(hold) => hold.balance >= 0"));
      yield* fs.writeFileString(lock, locked("(hold) => hold.balance >= -5"));
      yield* Verify.aggregate(Escrow, { lock });
      expect(yield* fs.readFileString(lock)).toBe(locked("(hold) => hold.balance >= 0"));
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a rule taken out of the code fails while the lock has it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      yield* Verify.aggregate(Covered, { lock });
      // Escrow is Covered without ReservedIsCovered: the lock, kept under its name, says so.
      const kept = (yield* fs.readFileString(lock)).replace('"Covered"', '"Escrow"');
      yield* fs.writeFileString(lock, kept);
      const error = yield* failure(Verify.aggregate(Escrow, { lock }));
      expect(error.message).toContain(
        "✗ ReservedIsCovered is locked in verify.lock.json, and is no longer a rule of Escrow",
      );
      expect(yield* fs.readFileString(lock)).toBe(kept);
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

it.effect(
  "under CI the lock is never written: a rule it does not have fails",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      const error = yield* failure(Verify.aggregate(Escrow, { lock }));
      expect(error.message).toContain(
        "✗ NeverOverdrawn is not in verify.lock.json: run the test outside CI, and commit the file it writes",
      );
      expect(yield* fs.exists(lock)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services(true))),
  60_000,
);

/** A lock that asks for more than Escrow has: ten kept back, and a rule it does not declare. */
const stricter = `${JSON.stringify(
  {
    version: 1,
    rules: {
      Escrow: {
        NeverOverdrawn: { kind: "invariant", source: "(hold) => hold.balance >= 10" },
        ReservedIsCovered: { kind: "invariant", source: "(hold) => hold.reserved >= 0" },
      },
    },
  },
  null,
  2,
)}\n`;

it.effect(
  "UPDATE_VERIFY_LOCK=1 locks every rule as it is written, and says what was let go",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      yield* fs.writeFileString(lock, stricter);
      const report = yield* Verify.aggregate(Escrow, { lock });
      expect(report.undone).toEqual([]);
      expect(report.relocked).toHaveLength(2);
      expect(report.relocked[0]).toMatch(
        /^NeverOverdrawn says less than the rule locked in verify\.lock\.json: \{ balance: \d, reserved: -?\d+ \} passes it now/,
      );
      expect(report.relocked[1]).toBe(
        "ReservedIsCovered is locked in verify.lock.json, and is no longer a rule of Escrow",
      );
      expect(Verify.render(report)).toContain(
        "Relocked with UPDATE_VERIFY_LOCK=1\n  ! NeverOverdrawn says less",
      );
      expect(yield* fs.readFileString(lock)).toBe(locked("(hold) => hold.balance >= 0"));
    }).pipe(Effect.scoped, Effect.provide(services(false, true))),
  60_000,
);

it.effect(
  "under CI, UPDATE_VERIFY_LOCK=1 relocks nothing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      yield* fs.writeFileString(lock, stricter);
      const error = yield* failure(Verify.aggregate(Escrow, { lock }));
      expect(error.message).toContain("✗ NeverOverdrawn says less than the rule locked");
      expect(error.message).toContain("✗ ReservedIsCovered is locked in verify.lock.json");
      expect(error.message).not.toContain("UPDATE_VERIFY_LOCK");
      expect(yield* fs.readFileString(lock)).toBe(stricter);
    }).pipe(Effect.scoped, Effect.provide(services(true, true))),
  60_000,
);

it.effect(
  "a model's lock keeps the rules of its aggregates and its own",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      yield* Verify.model(Kiosk, { apis: [KioskApi], walks: { count: 0 }, lock });
      const written = JSON.parse(yield* fs.readFileString(lock)) as {
        readonly rules: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      };
      expect(written.rules.Kiosk).toEqual({
        "Shelf.NeverBelowZero": { kind: "invariant", source: "(shelf) => shelf.stock >= 0" },
        "Kiosk.SomethingIsSold": {
          kind: "sometimes",
          source: "(kiosk) => kiosk.Shelf.some((shelf) => shelf.state.sold > 0)",
        },
      });
      // What must be possible is compared as text: one that changed fails.
      yield* fs.writeFileString(
        lock,
        (yield* fs.readFileString(lock)).replace("sold > 0", "sold > 1"),
      );
      const error = yield* failure(
        Verify.model(Kiosk, { apis: [KioskApi], walks: { count: 0 }, lock }),
      );
      expect(error.message).toContain(
        "✗ Kiosk.SomethingIsSold changed from the rule locked in verify.lock.json: only an invariant of an aggregate is compared with the one it was",
      );
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a rejection is needed by the rules that break when its check is taken out",
  () =>
    Effect.gen(function* () {
      // `Reserve` refuses more than the balance covers. With the rule that says so
      // written down, taking the check out breaks it.
      const covered = yield* Verify.aggregate(Covered, {
        require: { guards: ["Reserve.NotEnough"] },
      });
      expect(covered.proof.guards).toEqual([
        {
          command: "Reserve",
          rejection: "NotEnough",
          standing: "needed",
          rules: ["ReservedIsCovered"],
          reason: undefined,
        },
      ]);
      expect(Verify.render(covered)).not.toContain("Rejections no rule needs");
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a rejection no rule needs is named, and fails where one is required to",
  () =>
    Effect.gen(function* () {
      // The same check, in an aggregate whose only rule is about the balance: reserving
      // too much breaks nothing that is written down.
      const proof = yield* Prove.report(Escrow, {
        source: new URL("./fixtures/Escrow.aggregate.ts", import.meta.url),
      });
      expect(proof.guards).toMatchObject([
        { command: "Reserve", rejection: "NotEnough", standing: "unneeded", rules: [] },
      ]);
      expect(Prove.render(proof)).toContain(
        [
          "Rejections no rule needs: with the check taken out, the command records events on what it refused, and every rule is kept",
          "  ? Reserve.NotEnough",
        ].join("\n"),
      );
      const failed = yield* failure(
        Verify.aggregate(Escrow, { require: { guards: ["Reserve.NotEnough", "Pay.Nothing"] } }),
      );
      expect(failed).toMatchObject({ _tag: "NotVerified" });
      expect(failed.message).toContain(
        "Reserve.NotEnough is required to be needed by a rule, and every rule is kept with its check taken out",
      );
      expect(failed.message).toContain(
        "Pay.Nothing is required to be needed by a rule, and no command gives a rejection of that name",
      );
    }).pipe(Effect.provide(services(false))),
  60_000,
);

/** One event of an escrow, as it was committed. */
const recorded = (
  stream: string,
  seq: number,
  event: Paid | Reserved | Captured,
  commandId?: string,
) => ({
  event,
  envelope: {
    id: stream.slice(stream.indexOf("/") + 1),
    stream,
    seq,
    ...(commandId === undefined ? {} : { commandId }),
  },
});

it.effect(
  "a history the rules allow passes: each event is one a command records from the state it met",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.history(Covered, [
        recorded("Covered/a", 1, new Paid({ amount: 50 })),
        recorded("Covered/a", 2, new Reserved({ amount: 20 })),
        recorded("Covered/a", 3, new Captured({})),
        // Another instance, given out of order.
        recorded("Covered/b", 2, new Paid({ amount: 5 }), "c-2"),
        recorded("Covered/b", 1, new Paid({ amount: 1 }), "c-1"),
      ]);
      expect(report.instances).toMatchObject([
        { stream: "Covered/a", events: 3, commands: 3, explained: 3, state: { balance: 30 } },
        { stream: "Covered/b", events: 2, commands: 2, explained: 2, state: { balance: 6 } },
      ]);
      expect(Verify.render(report)).toBe(
        [
          "Covered: 2 instances, 5 events",
          "",
          "  ✓ every state along the way keeps the rules and the state's schema",
          "  ✓ 5 events are what 5 commands record, each from the state it met",
          "",
        ].join("\n"),
      );
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a history that breaks a rule fails, at the event that leaves the state",
  () =>
    Effect.gen(function* () {
      // More was reserved than was paid in: the rules as written refuse it, and the
      // state it leaves breaks one of them.
      const failed = yield* failure(
        Verify.history(Covered, [
          recorded("Covered/a", 1, new Paid({ amount: 50 })),
          recorded("Covered/a", 2, new Reserved({ amount: 80 })),
          recorded("Covered/a", 3, new Captured({})),
        ]),
      );
      expect(failed).toMatchObject({ _tag: "NotVerified" });
      expect(failed.message).toContain(
        "✗ Covered/a, event 2: ReservedIsCovered does not hold of { balance: 50, reserved: 80 }, the state it leaves",
      );
      expect(failed.message).toContain(
        "✗ Covered/a, event 3: NeverOverdrawn does not hold of { balance: -30, reserved: 0 }, the state it leaves",
      );
      expect(failed.message).toContain(
        [
          "No command records these from the state they met",
          "  ✗ Covered/a, event 2: Reserved { amount: 80 } from { balance: 50, reserved: 0 }",
        ].join("\n"),
      );
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "an event no command records from the state it met fails, unless that is allowed",
  () =>
    Effect.gen(function* () {
      // `Escrow` has no rule about what is reserved, so no state here breaks one.
      // `Reserve` still refuses 80 of a balance of 50: the event was not recorded by this code.
      const history = [
        recorded("Escrow/a", 1, new Paid({ amount: 50 })),
        recorded("Escrow/a", 2, new Reserved({ amount: 80 })),
      ];
      const failed = yield* failure(Verify.history(Escrow, history));
      expect(failed).toMatchObject({ _tag: "NotVerified" });
      if (failed._tag !== "NotVerified") return;
      expect(failed.report.broken).toEqual([]);
      expect(failed.report.unexplained).toEqual([
        "Escrow/a, event 2: Reserved { amount: 80 } from { balance: 50, reserved: 0 }",
      ]);
      const allowed = yield* Verify.history(Escrow, history, { allow: { unexplained: true } });
      expect(allowed.instances[0]).toMatchObject({ events: 2, commands: 1, explained: 1 });
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "events one command recorded together are explained together",
  () =>
    Effect.gen(function* () {
      // Two payments under one command id: no command of the escrow records two events.
      const failed = yield* failure(
        Verify.history(Escrow, [
          recorded("Escrow/a", 1, new Paid({ amount: 5 }), "c-1"),
          recorded("Escrow/a", 2, new Paid({ amount: 5 }), "c-1"),
        ]),
      );
      if (failed._tag !== "NotVerified") return expect(failed._tag).toBe("NotVerified");
      expect(failed.report.unexplained).toEqual([
        "Escrow/a, event 1: Paid { amount: 5 }, Paid { amount: 5 } from { balance: 0, reserved: 0 }",
      ]);
    }).pipe(Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a history that does not start at an instance's first event is not checked",
  () =>
    Effect.gen(function* () {
      const failed = yield* failure(
        Verify.history(Covered, [recorded("Covered/a", 2, new Paid({ amount: 50 }))]),
      );
      if (failed._tag !== "NotVerified") return expect(failed._tag).toBe("NotVerified");
      expect(failed.report.undone).toEqual([
        "Covered/a has no event 1: a history is folded from an instance's first event, with none left out",
      ]);
    }).pipe(Effect.provide(services(false))),
  60_000,
);
