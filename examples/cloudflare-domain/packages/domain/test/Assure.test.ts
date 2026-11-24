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
import { Covered, Escrow } from "./fixtures/Escrow.aggregate.ts";
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
    {
      version: 1,
      rules: { Escrow: { NeverOverdrawn: { kind: "invariant", source } } },
      aggregates: { Escrow: ["Escrow"] },
    },
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
      // Written another way: it allows the same states.
      yield* fs.writeFileString(lock, locked("(hold) =>\n  0 <= hold.balance"));
      yield* Verify.aggregate(Escrow, { lock });
      expect(yield* fs.readFileString(lock)).toBe(locked("(hold) => hold.balance >= 0"));
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

/** A lock of `Covered` from before it said the reserved amount is covered. */
const before = (rules: Record<string, string>) =>
  `${JSON.stringify(
    {
      version: 1,
      rules: {
        Covered: Object.fromEntries(
          Object.entries(rules).map(([name, source]) => [name, { kind: "invariant", source }]),
        ),
      },
      aggregates: { Covered: ["Covered"] },
    },
    null,
    2,
  )}\n`;

it.effect(
  "a rule that says more than the one locked fails, with a state an instance may be stored in",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      // The locked rule let an escrow go five below nothing: one recorded then may still be there.
      yield* fs.writeFileString(lock, locked("(hold) => hold.balance >= -5"));
      const error = yield* failure(Verify.aggregate(Escrow, { lock }));
      expect(error.message).toMatch(
        /✗ NeverOverdrawn says more than the rules locked in verify\.lock\.json: they allowed \{ balance: -[1-5], reserved: -?\d+ \}, and it refuses it\. An instance recorded before this change may be stored in such a state, and no proof starts from it: check that none is, or rewrite the ones that are/,
      );
      expect(error.message).toContain("UPDATE_VERIFY_LOCK=1");
      expect(yield* fs.readFileString(lock)).toBe(locked("(hold) => hold.balance >= -5"));
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

it.effect(
  "a new rule the locked ones did not keep fails, and is locked only when asked",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      const kept = before({ NeverOverdrawn: "(hold) => hold.balance >= 0" });
      yield* fs.writeFileString(lock, kept);
      const error = yield* failure(Verify.aggregate(Covered, { lock }));
      expect(error.message).toMatch(
        /✗ ReservedIsCovered is new, and the rules locked in verify\.lock\.json allowed \{ balance: \d+, reserved: -?\d+ \}, which it refuses\. An instance recorded before this change may be stored in such a state/,
      );
      expect(yield* fs.readFileString(lock)).toBe(kept);
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

it.effect(
  "UPDATE_VERIFY_LOCK=1 locks a new rule the locked ones did not keep, and says so",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      yield* fs.writeFileString(lock, before({ NeverOverdrawn: "(hold) => hold.balance >= 0" }));
      const report = yield* Verify.aggregate(Covered, { lock });
      expect(report.relocked).toHaveLength(1);
      expect(report.relocked[0]).toMatch(/^ReservedIsCovered is new, and the rules locked/);
      expect(yield* fs.readFileString(lock)).toBe(
        before({
          NeverOverdrawn: "(hold) => hold.balance >= 0",
          ReservedIsCovered: "(hold) => hold.reserved >= 0 && hold.reserved <= hold.balance",
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(services(false, true))),
  60_000,
);

it.effect(
  "under CI a new rule the locked ones did not keep fails for that, once",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      yield* fs.writeFileString(lock, before({ NeverOverdrawn: "(hold) => hold.balance >= 0" }));
      const error = yield* failure(Verify.aggregate(Covered, { lock }));
      expect(error.message).toContain("✗ ReservedIsCovered is new, and the rules locked");
      expect(error.message).not.toContain("ReservedIsCovered is not in verify.lock.json");
    }).pipe(Effect.scoped, Effect.provide(services(true))),
  60_000,
);

it.effect(
  "a new rule the locked ones already kept is added to the lock",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      // One rule said it all: it is now written as two.
      yield* fs.writeFileString(
        lock,
        before({
          NeverOverdrawn:
            "(hold) => hold.balance >= 0 && hold.reserved >= 0 && hold.reserved <= hold.balance",
        }),
      );
      const report = yield* Verify.aggregate(Covered, { lock });
      expect(report.undone).toEqual([]);
      expect(yield* fs.readFileString(lock)).toBe(
        before({
          NeverOverdrawn: "(hold) => hold.balance >= 0",
          ReservedIsCovered: "(hold) => hold.reserved >= 0 && hold.reserved <= hold.balance",
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(services(false))),
  60_000,
);

it.effect(
  "the first rule of an aggregate the lock already had is held against every state",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* lockIn("verify.lock.json");
      // Locked while it had no rule: its instances may be stored in any state of its schema.
      yield* fs.writeFileString(lock, before({}));
      const error = yield* failure(Verify.aggregate(Covered, { lock }));
      expect(error.message).toContain("✗ NeverOverdrawn is new, and the rules locked");
      expect(error.message).toContain("✗ ReservedIsCovered is new, and the rules locked");
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
      const kept = (yield* fs.readFileString(lock)).replaceAll('"Covered"', '"Escrow"');
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
        readonly aggregates: Readonly<Record<string, ReadonlyArray<string>>>;
      };
      expect(written.rules.Kiosk).toEqual({
        "Shelf.NeverBelowZero": { kind: "invariant", source: "(shelf) => shelf.stock >= 0" },
        "Kiosk.SomethingIsSold": {
          kind: "sometimes",
          source: "(kiosk) => kiosk.Shelf.some((shelf) => shelf.state.sold > 0)",
        },
      });
      expect(written).toMatchObject({ aggregates: { Kiosk: ["Shelf"] } });
      // An aggregate's invariant that says more is found under the model's name for it.
      const loose = (yield* fs.readFileString(lock)).replace("stock >= 0", "stock >= -5");
      yield* fs.writeFileString(lock, loose);
      const tightened = yield* failure(
        Verify.model(Kiosk, { apis: [KioskApi], walks: { count: 0 }, lock }),
      );
      expect(tightened.message).toContain(
        "✗ Shelf.NeverBelowZero says more than the rules locked in verify.lock.json",
      );
      yield* fs.writeFileString(lock, loose.replace("stock >= -5", "stock >= 0"));
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
