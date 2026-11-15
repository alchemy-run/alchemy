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

/** Wait until `check` holds: an instance settles on its own once its intent's deadline passes. */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("200 millis"), until: (ok) => ok, times: 60 }),
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.die(new Error("never happened")))),
  );

/**
 * The caller dies at one step of a commit: the first call of `method` to the
 * account `id` never arrives, and whoever made it never continues.
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

/** Send a transfer whose caller dies midway: it never answers, so it runs detached. */
const doomed = (commandId: string) =>
  Effect.gen(function* () {
    const transfer = yield* Transfer;
    yield* transfer
      .send(new TransferMoney({ from: a, to: b, amount: 30 }), { commandId })
      .pipe(Effect.ignoreCause, Effect.forkDetach);
  });

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

  describe(
    `Domain decision on Durable Objects${suffix}, the caller dies`,
    { tags: ["unit"] },
    () => {
      it.live(
        "before the second instance is prepared: nothing is recorded, and both are freed",
        () => {
          const crash = dieAt("txPrepare", "b");
          return Effect.gen(function* () {
            const accounts = yield* funded;
            yield* doomed("t-1");
            yield* eventually(Effect.sync(crash.died));
            // `a` holds the intent until its deadline; then its next command goes through.
            yield* accounts.send(new Deposit({ accountId: a, amount: 1 }));
            expect(yield* accounts.get(a)).toEqual({ balance: 101 });
            expect(yield* accounts.get(b)).toEqual({ balance: 0 });
            // And the same transfer can be decided again.
            const transfer = yield* Transfer;
            yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
            expect(yield* accounts.get(b)).toEqual({ balance: 30 });
          }).pipe(Effect.scoped, Effect.provide(onSimHost(crash.intercept)));
        },
        { timeout: 60_000 },
      );

      it.live(
        "after every instance is prepared, before the commit: nothing is recorded on either",
        () => {
          const crash = dieAt("txCommit", "a");
          return Effect.gen(function* () {
            const accounts = yield* funded;
            yield* doomed("t-1");
            yield* eventually(Effect.sync(crash.died));
            // `b` asks the primary, which aborts the intent once its deadline passed.
            yield* accounts.send(new Deposit({ accountId: b, amount: 1 }));
            expect(yield* accounts.get(b)).toEqual({ balance: 1 });
            yield* accounts.send(new Deposit({ accountId: a, amount: 1 }));
            expect(yield* accounts.get(a)).toEqual({ balance: 101 });
          }).pipe(Effect.scoped, Effect.provide(onSimHost(crash.intercept)));
        },
        { timeout: 60_000 },
      );

      it.live(
        "after the commit, before the second instance hears of it: it is recorded on both",
        () => {
          const crash = dieAt("txCommit", "b");
          return Effect.gen(function* () {
            const accounts = yield* funded;
            yield* doomed("t-1");
            yield* eventually(Effect.sync(crash.died));
            expect(yield* accounts.get(a)).toEqual({ balance: 70 });
            // `b` learns the outcome from the primary the next time it is asked to do anything.
            yield* accounts.send(new Deposit({ accountId: b, amount: 1 }));
            expect(yield* accounts.get(b)).toEqual({ balance: 31 });
            // Sent again with the same id, the transfer is not decided twice.
            const transfer = yield* Transfer;
            const again = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }), {
              commandId: "t-1",
            });
            expect(again.commits).toEqual([
              { stream: "Account/a", version: 2 },
              { stream: "Account/b", version: 1 },
            ]);
            expect(yield* accounts.get(a)).toEqual({ balance: 70 });
          }).pipe(Effect.scoped, Effect.provide(onSimHost(crash.intercept)));
        },
        { timeout: 60_000 },
      );

      it.live(
        "the commit's answer is lost once: the decision still commits once, on both",
        () => {
          // The commit lands, and its answer doesn't: the sender asks again.
          let lost = false;
          const intercept: Intercept = (call, run) =>
            call.method !== "txCommit" || call.args[0] !== "a"
              ? run
              : // Decided each time the call is made: a retry is the same Effect, run again.
                Effect.suspend(() => {
                  if (lost) return run;
                  lost = true;
                  return Effect.andThen(run, Effect.fail(new Error("the answer was lost")));
                });
          return Effect.gen(function* () {
            const accounts = yield* funded;
            const transfer = yield* Transfer;
            const receipt = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
            expect(lost).toBe(true);
            expect(receipt.commits).toEqual([
              { stream: "Account/a", version: 2 },
              { stream: "Account/b", version: 1 },
            ]);
            expect(yield* accounts.get(a)).toEqual({ balance: 70 });
            expect(yield* accounts.get(b)).toEqual({ balance: 30 });
          }).pipe(Effect.scoped, Effect.provide(onSimHost(intercept)));
        },
        { timeout: 60_000 },
      );

      it.live(
        "told to abort after the commit landed, the second instance applies it instead",
        () => {
          // The commit lands on `a` and the sender never hears of it. Whatever it
          // does next, it can't make `b` drop a decision that happened.
          let txId: string | undefined;
          let committed = false;
          const intercept: Intercept = (call, run) => {
            if (call.method === "txPrepare") {
              txId = (call.args[1] as { readonly txId: string }).txId;
            }
            if (committed || call.method !== "txCommit" || call.args[0] !== "a") return run;
            committed = true;
            return Effect.andThen(run, Effect.never);
          };
          const sim = simHost({ rowsRead: 0 }, { inputGate, intercept });
          return Effect.gen(function* () {
            const accounts = yield* funded;
            yield* doomed("t-1");
            yield* eventually(Effect.sync(() => committed));
            expect(yield* accounts.get(a)).toEqual({ balance: 70 });
            const accountObjects = sim.host.lookup!(
              { modelName: "DecisionBank", id: {}, sagas: [], legacyData: false },
              "AccountAggregate",
            )!;
            yield* accountObjects.getByName("b").txAbort!("b", txId);
            expect(yield* accounts.get(b)).toEqual({ balance: 30 });
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
        "an instance nobody touches again still applies a committed decision",
        () => {
          const crash = dieAt("txCommit", "b");
          return Effect.gen(function* () {
            const accounts = yield* funded;
            yield* doomed("t-1");
            yield* eventually(Effect.sync(crash.died));
            // No command reaches `b`: it settles itself once the deadline has passed.
            yield* eventually(Effect.map(accounts.get(b), (state) => state.balance === 30));
          }).pipe(Effect.scoped, Effect.provide(onSimHost(crash.intercept)));
        },
        { timeout: 60_000 },
      );
    },
  );
}
