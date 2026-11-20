import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { describe, expect, it } from "@alchemy.run/test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import {
  Account,
  AccountId,
  Balance,
  Bank,
  CustomerId,
  Deposit,
  InsufficientFunds,
  RegisterCustomer,
  Registration,
  Transfer,
  TransferMoney,
  Username,
} from "./decision-model.ts";
import { type Intercept, simHost } from "./sim-host.ts";

const a = AccountId.make("a");
const b = AccountId.make("b");

/**
 * The bank on in-process Durable Objects; `intercept` decides what happens to
 * calls between them. With `inputGate`, each instance has the gate Rivet and
 * Effect Cluster run storage behind.
 */
const hostOn = (inputGate: boolean) => (intercept?: Intercept) =>
  Bank.layer(Layer.empty).pipe(
    Layer.provideMerge(
      DurableObjects.makePlatform(
        simHost({ rowsRead: 0 }, { inputGate, ...(intercept === undefined ? {} : { intercept }) })
          .host,
      ),
    ),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );

/** Account `a` with 100. */
const funded = Effect.gen(function* () {
  const accounts = yield* Account;
  yield* accounts.send(new Deposit({ accountId: a, amount: 100 }));
  return accounts;
});

/** Wait until `check` holds: an instance left midway finishes on its own, on a wake-up. */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("200 millis"), until: (ok) => ok, times: 60 }),
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.die(new Error("never happened")))),
  );

/**
 * Whoever drives a commit stops at one step: the first call of `method` to
 * the account `id` never arrives, and whoever made it never continues.
 */
const dieAt = (method: string, id: string) => {
  let died = false;
  const intercept: Intercept = (call, run) => {
    if (died || call.method !== method || call.args[0] !== id) return run;
    died = true;
    return Effect.never;
  };
  return { intercept, died: () => died };
};

/**
 * The first `times` calls of `method` to the account `id` fail. With
 * `landed`, each one arrives and only its answer is lost.
 */
const failAt = (method: string, id: string, times: number, landed = false) => {
  let failed = 0;
  const intercept: Intercept = (call, run) =>
    call.method !== method || call.args[0] !== id
      ? run
      : // Decided each time the call is made: a retry is the same Effect, run again.
        Effect.suspend(() => {
          if (failed >= times) return run;
          failed += 1;
          const lost = Effect.fail(new Error("the call was lost"));
          return landed ? Effect.andThen(run, lost) : lost;
        });
  return { intercept, failed: () => failed };
};

/** Send a transfer nobody waits for: what drives it may stop midway. */
const detached = (commandId: string) =>
  Effect.gen(function* () {
    const transfer = yield* Transfer;
    yield* transfer
      .send(new TransferMoney({ from: a, to: b, amount: 30 }), { commandId })
      .pipe(Effect.ignoreCause, Effect.forkDetach);
  });

const both = [
  { stream: "Account/a", version: 2 },
  { stream: "Account/b", version: 1 },
];

// Once as Cloudflare runs an instance, and once behind an input gate, as Rivet and Effect Cluster do.
for (const inputGate of [false, true]) {
  const onSimHost = hostOn(inputGate);
  const suffix = inputGate ? ", behind an input gate" : "";

  describe(`Domain decision on Durable Objects${suffix}`, { tags: ["unit"] }, () => {
    it.live("commits to every instance it read, and replies", () =>
      Effect.gen(function* () {
        const accounts = yield* funded;
        const transfer = yield* Transfer;
        const receipt = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
        expect(receipt.reply).toEqual({ balance: 70 });
        expect(receipt.commits).toEqual([
          { stream: "Account/a", version: 2 },
          { stream: "Account/b", version: 1 },
        ]);
        expect(yield* accounts.get(a)).toEqual({ balance: 70 });
        expect(yield* accounts.get(b)).toEqual({ balance: 30 });
        // Each instance takes its own commands again.
        yield* accounts.send(new Deposit({ accountId: b, amount: 5 }));
        expect(yield* accounts.get(b)).toEqual({ balance: 35 });
      }).pipe(Effect.scoped, Effect.provide(onSimHost())),
    );

    it.live("a rejection records nothing and holds nothing", () =>
      Effect.gen(function* () {
        const accounts = yield* funded;
        const transfer = yield* Transfer;
        const rejection = yield* Effect.flip(
          transfer.send(new TransferMoney({ from: a, to: b, amount: 500 })),
        );
        expect(rejection).toEqual(new InsufficientFunds({ balance: 100 }));
        yield* accounts.send(new Deposit({ accountId: a, amount: 1 }));
        expect(yield* accounts.get(a)).toEqual({ balance: 101 });
        expect(yield* accounts.get(b)).toEqual({ balance: 0 });
      }).pipe(Effect.scoped, Effect.provide(onSimHost())),
    );

    it.live("a command id already committed returns its first receipt", () =>
      Effect.gen(function* () {
        const accounts = yield* funded;
        const transfer = yield* Transfer;
        const command = new TransferMoney({ from: a, to: b, amount: 30 });
        const first = yield* transfer.send(command, { commandId: "t-1" });
        const again = yield* transfer.send(command, { commandId: "t-1" });
        expect(again).toEqual(first);
        expect(yield* accounts.get(a)).toEqual({ balance: 70 });
        expect(yield* accounts.get(b)).toEqual({ balance: 30 });
      }).pipe(Effect.scoped, Effect.provide(onSimHost())),
    );

    it.live("its events reach views like any other", () =>
      Effect.gen(function* () {
        yield* funded;
        const transfer = yield* Transfer;
        const receipt = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
        const balances = yield* Balance;
        expect(yield* balances.get(Account.ref("a"), { atLeast: receipt.commits[0]! })).toEqual(
          Option.some({ balance: 70, transfers: 1 }),
        );
        expect(yield* balances.get(Account.ref("b"), { atLeast: receipt.commits[1]! })).toEqual(
          Option.some({ balance: 30, transfers: 1 }),
        );
      }).pipe(Effect.scoped, Effect.provide(onSimHost())),
    );

    it.live(
      "concurrent transfers in both directions never overdraw, and none is lost",
      () =>
        Effect.gen(function* () {
          const accounts = yield* funded;
          yield* accounts.send(new Deposit({ accountId: b, amount: 100 }));
          const transfer = yield* Transfer;
          // Opposite directions share both instances: preparing in stream order keeps them from deadlocking.
          const exits = yield* Effect.forEach(
            Array.from({ length: 12 }, (_, i) => i),
            (i) =>
              Effect.exit(
                transfer.send(
                  new TransferMoney(
                    i % 2 === 0 ? { from: a, to: b, amount: 40 } : { from: b, to: a, amount: 40 },
                  ),
                ),
              ),
            { concurrency: "unbounded" },
          );
          const sent = exits.filter(Exit.isSuccess).length;
          const balances = [(yield* accounts.get(a)).balance, (yield* accounts.get(b)).balance];
          // Money is conserved, nobody is overdrawn, and every accepted transfer landed on both sides.
          expect(balances[0]! + balances[1]!).toBe(200);
          expect(Math.min(...balances)).toBeGreaterThanOrEqual(0);
          expect(sent).toBeGreaterThan(0);
          const events = yield* Effect.forEach([a, b], (id) =>
            accounts
              .send(new Deposit({ accountId: id, amount: 0 }))
              .pipe(Effect.map((r) => r.version - 2)),
          );
          expect(events[0]! + events[1]!).toBe(sent * 2);
        }).pipe(Effect.scoped, Effect.provide(onSimHost())),
      { timeout: 60_000 },
    );

    it.live(
      "racing registrations for one username: exactly one wins",
      () =>
        Effect.gen(function* () {
          const registration = yield* Registration;
          const exits = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, i) => CustomerId.make(`r-${i}`)),
            (customerId) =>
              Effect.exit(
                registration.send(
                  new RegisterCustomer({
                    customerId,
                    name: "Racer",
                    username: Username.make("sam"),
                  }),
                ),
              ),
            { concurrency: "unbounded" },
          );
          expect(exits.filter(Exit.isSuccess).length).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(onSimHost())),
      { timeout: 60_000 },
    );
  });

  describe(`Domain decision on Durable Objects${suffix}, interrupted`, { tags: ["unit"] }, () => {
    it.live(
      "the sender hangs up: the decision commits without it",
      () => {
        // The command reaches the primary; its answer never reaches the sender.
        let sent = false;
        const intercept: Intercept = (call, run) => {
          if (call.method !== "txDecide") return run;
          sent = true;
          return Effect.andThen(Effect.forkDetach(run), Effect.never);
        };
        return Effect.gen(function* () {
          const accounts = yield* funded;
          yield* detached("t-1");
          yield* eventually(Effect.sync(() => sent));
          yield* eventually(Effect.map(accounts.get(b), (state) => state.balance === 30));
          expect(yield* accounts.get(a)).toEqual({ balance: 70 });
        }).pipe(Effect.scoped, Effect.provide(onSimHost(intercept)));
      },
      { timeout: 60_000 },
    );

    it.live(
      "the primary stops before the second instance is prepared: it finishes on its wake-up",
      () => {
        const crash = dieAt("txPrepare", "b");
        return Effect.gen(function* () {
          const accounts = yield* funded;
          yield* detached("t-1");
          yield* eventually(Effect.sync(crash.died));
          // Nothing is recorded yet: `a` only holds the decision.
          expect(yield* accounts.get(a)).toEqual({ balance: 100 });
          // Nobody touches either account. `a` wakes, and carries the decision to its end.
          yield* eventually(Effect.map(accounts.get(b), (state) => state.balance === 30));
          expect(yield* accounts.get(a)).toEqual({ balance: 70 });
          // Sent again with the same id, it is not decided twice.
          const transfer = yield* Transfer;
          const again = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }), {
            commandId: "t-1",
          });
          expect(again.commits).toEqual(both);
          expect(yield* accounts.get(a)).toEqual({ balance: 70 });
        }).pipe(Effect.scoped, Effect.provide(onSimHost(crash.intercept)));
      },
      { timeout: 60_000 },
    );

    it.live(
      "a command that finds the primary held carries the decision on first",
      () => {
        const crash = dieAt("txPrepare", "b");
        return Effect.gen(function* () {
          const accounts = yield* funded;
          yield* detached("t-1");
          yield* eventually(Effect.sync(crash.died));
          // The deposit waits for the transfer, then lands on top of it.
          yield* accounts.send(new Deposit({ accountId: a, amount: 1 }));
          expect(yield* accounts.get(a)).toEqual({ balance: 71 });
          expect(yield* accounts.get(b)).toEqual({ balance: 30 });
        }).pipe(Effect.scoped, Effect.provide(onSimHost(crash.intercept)));
      },
      { timeout: 60_000 },
    );

    it.live(
      "every object is evicted midway: the primary finishes from its storage",
      () => {
        // `b` is prepared, and the primary never hears that it is.
        let prepared = false;
        const intercept: Intercept = (call, run) => {
          if (prepared || call.method !== "txPrepare" || call.args[0] !== "b") return run;
          prepared = true;
          return Effect.andThen(run, Effect.never);
        };
        const sim = simHost({ rowsRead: 0 }, { inputGate, intercept });
        return Effect.gen(function* () {
          const accounts = yield* funded;
          yield* detached("t-1");
          yield* eventually(Effect.sync(() => prepared));
          // What the objects held in memory is gone; their storage and alarms stay.
          yield* sim.evict;
          yield* eventually(Effect.map(accounts.get(b), (state) => state.balance === 30));
          expect(yield* accounts.get(a)).toEqual({ balance: 70 });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Bank.layer(Layer.empty).pipe(
              Layer.provideMerge(DurableObjects.makePlatform(sim.host)),
              Layer.provideMerge(SecureRandom.layerWebCrypto),
            ),
          ),
        );
      },
      { timeout: 60_000 },
    );

    it.live(
      "the primary stops after the commit: the second instance is told on its wake-up",
      () => {
        const crash = dieAt("txCommit", "b");
        return Effect.gen(function* () {
          const accounts = yield* funded;
          yield* detached("t-1");
          yield* eventually(Effect.sync(crash.died));
          // The decision happened: it is on `a`, and nobody touches `b`.
          expect(yield* accounts.get(a)).toEqual({ balance: 70 });
          yield* eventually(Effect.map(accounts.get(b), (state) => state.balance === 30));
        }).pipe(Effect.scoped, Effect.provide(onSimHost(crash.intercept)));
      },
      { timeout: 60_000 },
    );

    it.live(
      "the second instance, not yet told of the commit, asks the primary before its next command",
      () => {
        const crash = dieAt("txCommit", "b");
        return Effect.gen(function* () {
          const accounts = yield* funded;
          yield* detached("t-1");
          yield* eventually(Effect.sync(crash.died));
          yield* accounts.send(new Deposit({ accountId: b, amount: 1 }));
          expect(yield* accounts.get(b)).toEqual({ balance: 31 });
        }).pipe(Effect.scoped, Effect.provide(onSimHost(crash.intercept)));
      },
      { timeout: 60_000 },
    );

    it.live(
      "the second instance can't be reached: the attempt aborts, and the next one commits",
      () => {
        // More failures than one attempt retries.
        const lost = failAt("txPrepare", "b", 6);
        return Effect.gen(function* () {
          const accounts = yield* funded;
          const transfer = yield* Transfer;
          const receipt = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
          expect(lost.failed()).toBe(6);
          // Decided once, however many attempts it took.
          expect(receipt.commits).toEqual(both);
          expect(yield* accounts.get(a)).toEqual({ balance: 70 });
          expect(yield* accounts.get(b)).toEqual({ balance: 30 });
        }).pipe(Effect.scoped, Effect.provide(onSimHost(lost.intercept)));
      },
      { timeout: 60_000 },
    );

    it.live(
      "an instance prepared for an attempt that aborted without it hearing drops what it holds",
      () => {
        // `b` holds the intent, but the primary never hears that it does, and
        // the abort it then sends is lost too.
        const prepares = failAt("txPrepare", "b", 6, true);
        const aborts = failAt("txAbort", "b", 1);
        const intercept: Intercept = (call, run) =>
          prepares.intercept(call, aborts.intercept(call, run));
        return Effect.gen(function* () {
          const accounts = yield* funded;
          const transfer = yield* Transfer;
          // The next attempt reads `b`, which asks the primary and lets go.
          const receipt = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
          expect(aborts.failed()).toBe(1);
          expect(receipt.commits).toEqual(both);
          expect(yield* accounts.get(a)).toEqual({ balance: 70 });
          expect(yield* accounts.get(b)).toEqual({ balance: 30 });
        }).pipe(Effect.scoped, Effect.provide(onSimHost(intercept)));
      },
      { timeout: 60_000 },
    );

    it.live(
      "the commit reaches the second instance and its answer is lost: it is recorded once",
      () => {
        const lost = failAt("txCommit", "b", 1, true);
        return Effect.gen(function* () {
          const accounts = yield* funded;
          const transfer = yield* Transfer;
          yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
          expect(lost.failed()).toBe(1);
          expect(yield* accounts.get(b)).toEqual({ balance: 30 });
          // The primary tells it again on its wake-up, which changes nothing.
          yield* Effect.sleep("5 seconds");
          const receipt = yield* accounts.send(new Deposit({ accountId: b, amount: 0 }));
          expect(receipt.version).toBe(2);
          expect(yield* accounts.get(b)).toEqual({ balance: 30 });
        }).pipe(Effect.scoped, Effect.provide(onSimHost(lost.intercept)));
      },
      { timeout: 60_000 },
    );
  });
}
