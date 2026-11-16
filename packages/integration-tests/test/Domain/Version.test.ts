import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
    Withdraw: (_, cmd) => [new Withdrawn({ amount: cmd.amount })],
  },
  evolve: {
    Deposited: (s, e) => ({ balance: s.balance + e.amount }),
    Withdrawn: (s, e) => ({ balance: s.balance - e.amount }),
  },
}) {}

const Net = Schema.Struct({ net: Schema.Number });

/** One row per account, counting deposits only: the version 0 the model deployed first. */
class Summary extends Domain.View("Summary", {
  from: [Account],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (s, e) => ({ net: s.net + e.amount }) },
}) {}
/** Fixed to count withdrawals too, an event its keys never received: version 1. */
class SummaryV1 extends Domain.View("Summary", {
  from: [Account],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: {
    Deposited: (s, e) => ({ net: s.net + e.amount }),
    Withdrawn: (s, e) => ({ net: s.net - e.amount }),
  },
  version: 1,
}) {}

/** One row for every account: fed by many instances. */
const Total = Schema.Struct({ total: Schema.Number });
class Totals extends Domain.View("Totals", {
  from: [Account],
  key: Schema.String,
  keyOf: { Deposited: () => "all" },
  state: Total,
  initial: { total: 0 },
  evolve: { Deposited: (s, e) => ({ total: s.total + e.amount }) },
}) {}
class TotalsV1 extends Domain.View("Totals", {
  from: [Account],
  key: Schema.String,
  keyOf: { Deposited: () => "all" },
  state: Total,
  initial: { total: 0 },
  evolve: { Deposited: (s, e) => ({ total: s.total + e.amount * 10 }) },
  version: 1,
}) {}

/** Each account's latest net: built on `Summary`, so rebuilt from its rows. */
class Latest extends Domain.View("Latest", {
  from: [Summary],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (_, __, { state }) => ({ net: state?.net ?? 0 }) },
}) {}
class LatestOfV1 extends Domain.View("Latest", {
  from: [SummaryV1],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: {
    Deposited: (_, __, { state }) => ({ net: state?.net ?? 0 }),
    Withdrawn: (_, __, { state }) => ({ net: state?.net ?? 0 }),
  },
}) {}

class Bank extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [Summary, Totals, Latest],
}) {}
class BankV1 extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [SummaryV1, TotalsV1, LatestOfV1],
}) {}

/**
 * An in-memory platform that outlives the models built on it, as storage
 * outlives a deploy. It delivers only when drained.
 */
const platform = () => {
  const hosted = InMemory.make({ manual: true });
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* hosted.control.drain;
      if (yield* hosted.control.idle) return;
      yield* Effect.sleep("1 millis");
    }
  });
  return {
    settle,
    deploy: <A, E, R>(
      model: { readonly layer: (policies: any) => Layer.Layer<any, any, any> },
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(
        Effect.tap(() => settle),
        Effect.provide(model.layer(Layer.empty).pipe(Layer.provide(hosted.layer))),
      ),
  };
};

const send = (id: string, command: Deposit | Withdraw) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    yield* accounts.send(Account.ref(id), command);
  });

const history = [
  send("a-1", new Deposit({ amount: 10 })),
  send("a-1", new Withdraw({ amount: 4 })),
  send("a-2", new Deposit({ amount: 3 })),
];

describe("Domain view versions", { tags: ["unit", "local"] }, () => {
  it.live(
    "a view keyed by its aggregate is rebuilt in place: each key reads its events again",
    () =>
      Effect.gen(function* () {
        const bank = platform();
        yield* bank.deploy(Bank, Effect.all(history));
        const [complete, a1, a2] = yield* bank.deploy(
          BankV1,
          Effect.gen(function* () {
            const view = yield* SummaryV1;
            // Nothing to wait for, before anything is delivered.
            const { complete } = yield* view.history;
            const a1 = Option.getOrUndefined(yield* view.get(Account.ref("a-1")));
            const a2 = Option.getOrUndefined(yield* view.get(Account.ref("a-2")));
            return [complete, a1, a2] as const;
          }),
        );
        expect(complete).toBe(true);
        // The withdrawal, which the old view never received, counts.
        expect(a1).toEqual({ net: 6 });
        expect(a2).toEqual({ net: 3 });
      }),
  );

  it.live("a view fed by many instances is rebuilt from the history", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Bank, Effect.all(history));
      const [before, after, total] = yield* bank.deploy(
        BankV1,
        Effect.gen(function* () {
          const view = yield* TotalsV1;
          const before = (yield* view.history).complete;
          yield* bank.settle;
          return [
            before,
            (yield* view.history).complete,
            Option.getOrUndefined(yield* view.get("all")),
          ] as const;
        }),
      );
      expect(before).toBe(false);
      expect(after).toBe(true);
      expect(total).toEqual({ total: 130 });
    }),
  );

  it.live("a view built on a rebuilt view is rebuilt from its new rows", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Bank, Effect.all(history));
      expect(
        yield* bank.deploy(
          Bank,
          bank.settle.pipe(
            Effect.andThen(
              Effect.gen(function* () {
                return yield* (yield* Latest).get(Account.ref("a-1"));
              }),
            ),
          ),
        ),
      ).toEqual(Option.some({ net: 10 }));
      // No key of SummaryV1 is read first: Latest's rebuild reads them, and each
      // has its new rows before it answers.
      const top = yield* bank.deploy(
        BankV1,
        Effect.gen(function* () {
          yield* bank.settle;
          return Option.getOrUndefined(yield* (yield* LatestOfV1).get(Account.ref("a-1")));
        }),
      );
      expect(top).toEqual({ net: 6 });
    }),
  );
  it.live("an account opened after the bump fills its rebuilt row", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Bank, Effect.all(history));
      const fresh = yield* bank.deploy(
        BankV1,
        Effect.gen(function* () {
          yield* send("a-9", new Deposit({ amount: 7 }));
          yield* send("a-9", new Withdraw({ amount: 2 }));
          yield* bank.settle;
          return Option.getOrUndefined(yield* (yield* SummaryV1).get(Account.ref("a-9")));
        }),
      );
      expect(fresh).toEqual({ net: 5 });
    }),
  );
});

// ------------------------------------------------------------ aggregate versions

const evolveBalance = {
  Deposited: (s: { readonly balance: number }, e: Deposited) => ({ balance: s.balance + e.amount }),
  Withdrawn: (s: { readonly balance: number }, e: Withdrawn) => ({ balance: s.balance - e.amount }),
};

/** The account the model deployed first, at version 0, with a fault: withdrawals are not subtracted. */
class AccountV0 extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
    Withdraw: (_, cmd) => [new Withdrawn({ amount: cmd.amount })],
  },
  evolve: { Deposited: evolveBalance.Deposited, Withdrawn: (s) => s },
}) {}
/** The fault fixed, at version 1. */
class AccountV1 extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
    Withdraw: (_, cmd) => [new Withdrawn({ amount: cmd.amount })],
  },
  evolve: evolveBalance,
  version: 1,
}) {}
/** The same fix, without a version bump. */
class AccountFixedOnly extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
    Withdraw: (_, cmd) => [new Withdrawn({ amount: cmd.amount })],
  },
  evolve: evolveBalance,
}) {}
/** The fix with the state reshaped (`balance` renamed `total`), at version 1. */
class AccountTotal extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Total,
  initial: { total: 0 },
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
    Withdraw: (_, cmd) => [new Withdrawn({ amount: cmd.amount })],
  },
  evolve: {
    Deposited: (s, e) => ({ total: s.total + e.amount }),
    Withdrawn: (s, e) => ({ total: s.total - e.amount }),
  },
  version: 1,
}) {}

/** One row per account, counting deposits only: the same view on either account. */
class SummaryOfV0 extends Domain.View("Summary", {
  from: [AccountV0],
  key: AccountV0,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (s, e) => ({ net: s.net + e.amount }) },
}) {}
class SummaryOfV1 extends Domain.View("Summary", {
  from: [AccountV1],
  key: AccountV1,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (s, e) => ({ net: s.net + e.amount }) },
}) {}

class BankOfV0 extends Domain.Model("Bank", { aggregates: [AccountV0], views: [SummaryOfV0] }) {}
class BankOfV1 extends Domain.Model("Bank", { aggregates: [AccountV1], views: [SummaryOfV1] }) {}
class BankFixedOnly extends Domain.Model("Bank", { aggregates: [AccountFixedOnly] }) {}
class BankOfTotal extends Domain.Model("Bank", { aggregates: [AccountTotal] }) {}

/** Deposit 10, withdraw 4. */
const deposited = [
  send("a-1", new Deposit({ amount: 10 })),
  send("a-1", new Withdraw({ amount: 4 })),
];

const balance = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* Account).get(Account.ref(id));
  });

describe("Domain aggregate versions", { tags: ["unit", "local"] }, () => {
  it.live("bumping an aggregate's version folds its state again, before any command", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(BankOfV0, Effect.all(deposited));
      expect(yield* bank.deploy(BankOfV0, balance("a-1"))).toEqual({ balance: 10 });
      expect(yield* bank.deploy(BankOfV1, balance("a-1"))).toEqual({ balance: 6 });
    }),
  );

  it.live("a command after the bump decides on the state folded again", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(BankOfV0, Effect.all(deposited));
      const after = yield* bank.deploy(
        BankOfV1,
        send("a-1", new Deposit({ amount: 1 })).pipe(Effect.andThen(balance("a-1"))),
      );
      expect(after).toEqual({ balance: 7 });
    }),
  );

  it.live("the same fix without a version bump keeps the saved state", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(BankOfV0, Effect.all(deposited));
      expect(yield* bank.deploy(BankFixedOnly, balance("a-1"))).toEqual({ balance: 10 });
    }),
  );

  it.live("folding again records nothing: the stream and the views are unchanged", () =>
    Effect.gen(function* () {
      const hosted = InMemory.make({ manual: true });
      const settle = Effect.gen(function* () {
        while (true) {
          yield* hosted.control.drain;
          if (yield* hosted.control.idle) return;
          yield* Effect.sleep("1 millis");
        }
      });
      const on = (model: typeof BankOfV0 | typeof BankOfV1) =>
        Effect.provide(model.layer(Layer.empty).pipe(Layer.provide(hosted.layer)));
      const summary = (view: typeof SummaryOfV0 | typeof SummaryOfV1) =>
        Effect.gen(function* () {
          yield* settle;
          return Option.getOrUndefined(yield* (yield* view).get(Account.ref("a-1")));
        });
      yield* Effect.all(deposited).pipe(Effect.andThen(settle), on(BankOfV0));
      const before = yield* summary(SummaryOfV0).pipe(on(BankOfV0));
      const commits = hosted.control.commits.length;
      const [state, after] = yield* Effect.all([balance("a-1"), summary(SummaryOfV1)]).pipe(
        on(BankOfV1),
      );
      expect(state).toEqual({ balance: 6 });
      expect(hosted.control.commits.length).toBe(commits);
      expect(after).toEqual(before);
      // The stream's version is still 2: the next event is its third.
      const receipt = yield* Effect.gen(function* () {
        return yield* (yield* Account).send(Account.ref("a-1"), new Deposit({ amount: 1 }));
      }).pipe(on(BankOfV1));
      expect(receipt.version).toBe(3);
    }),
  );

  it.live("a state reshaped at the bump reads back in its new shape", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(BankOfV0, Effect.all(deposited));
      const reshaped = yield* bank.deploy(
        BankOfTotal,
        Effect.gen(function* () {
          return yield* (yield* AccountTotal).get(AccountTotal.ref("a-1"));
        }),
      );
      expect(reshaped).toEqual({ total: 6 });
    }),
  );

  it.live("an account first opened after the bump works as before", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(BankOfV0, Effect.all(deposited));
      const opened = yield* bank.deploy(
        BankOfV1,
        Effect.gen(function* () {
          yield* send("a-9", new Deposit({ amount: 7 }));
          yield* send("a-9", new Withdraw({ amount: 2 }));
          return yield* balance("a-9");
        }),
      );
      expect(opened).toEqual({ balance: 5 });
    }),
  );
});
