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
  input: { id: Schema.String, amount: Schema.Number },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  input: { id: Schema.String, amount: Schema.Number },
  events: [Withdrawn],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  keyOf: (command) => command.id,
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

class Line extends Domain.Event("Line", { amount: Schema.Number }) {}
/** Each account's movements, as its statement projection wrote them. */
class Lines extends Domain.Stream("Lines", { key: Account, entries: [Line] }) {}

/** Writes a line for every deposit and withdrawal. */
class Statement extends Domain.Projection("Statement", {
  from: [Account],
  key: Account,
  on: [Deposited, Withdrawn],
  writes: [Lines],
}) {}
/** Deposits only, at version 1: rebuilt from a history that now gives it fewer inputs. */
class StatementV1 extends Domain.Projection("Statement", {
  from: [Account],
  key: Account,
  on: [Deposited],
  writes: [Lines],
}) {}

const StatementLive = Statement.toLayer(
  Effect.gen(function* () {
    const lines = yield* Lines;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const amount = input.event._tag === "Withdrawn" ? -input.event.amount : input.event.amount;
        yield* lines.append(input, new Line({ amount }));
      }
    });
  }),
);
const StatementV1Live = StatementV1.toLayer(
  Effect.gen(function* () {
    const lines = yield* Lines;
    return Effect.fn(function* (batch) {
      for (const input of batch)
        yield* lines.append(input, new Line({ amount: input.event.amount }));
    });
  }),
  { version: 1 },
);

class Statements extends Domain.Model("Statements", {
  aggregates: [Account],
  projections: [Statement],
  streams: [Lines],
}) {}
class StatementsV1 extends Domain.Model("Statements", {
  aggregates: [Account],
  projections: [StatementV1],
  streams: [Lines],
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
      model: { readonly layer: (handlers: any) => Layer.Layer<any, any, any> },
      effect: Effect.Effect<A, E, R>,
      handlers?: Layer.Layer<any, any, any>,
    ) =>
      effect.pipe(
        Effect.tap(() => settle),
        Effect.provide(model.layer(handlers ?? Layer.empty).pipe(Layer.provide(hosted.layer))),
      ),
  };
};

const send = (command: Deposit | Withdraw) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    yield* accounts.send(command);
  });

const history = [
  send(new Deposit({ id: "a-1", amount: 10 })),
  send(new Withdraw({ id: "a-1", amount: 4 })),
  send(new Deposit({ id: "a-2", amount: 3 })),
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
          yield* send(new Deposit({ id: "a-9", amount: 7 }));
          yield* send(new Withdraw({ id: "a-9", amount: 2 }));
          yield* bank.settle;
          return Option.getOrUndefined(yield* (yield* SummaryV1).get(Account.ref("a-9")));
        }),
      );
      expect(fresh).toEqual({ net: 5 });
    }),
  );
});

describe("Domain projection versions", { tags: ["unit", "local"] }, () => {
  it.live("a rebuilt projection keeps its stream, and appends what follows the bump", () =>
    Effect.gen(function* () {
      const bank = platform();
      const lines = Effect.gen(function* () {
        yield* bank.settle;
        const { entries } = yield* (yield* Lines).list(Account.ref("a-1"));
        return entries.map((entry) => entry.event.amount);
      });
      const before = yield* bank.deploy(
        Statements,
        Effect.all([
          send(new Deposit({ id: "a-1", amount: 10 })),
          send(new Withdraw({ id: "a-1", amount: 4 })),
          send(new Deposit({ id: "a-1", amount: 3 })),
        ]).pipe(Effect.andThen(lines)),
        StatementLive,
      );
      expect(before).toEqual([10, -4, 3]);
      // Rebuilt, it replays two deposits where it handled three inputs before.
      const after = yield* bank.deploy(
        StatementsV1,
        Effect.gen(function* () {
          yield* bank.settle;
          yield* send(new Deposit({ id: "a-1", amount: 5 }));
          yield* send(new Deposit({ id: "a-1", amount: 7 }));
          return yield* lines;
        }),
        StatementV1Live,
      );
      // The replay appends nothing again, and nothing after the bump is lost.
      expect(after).toEqual([10, -4, 3, 5, 7]);
    }),
  );
});
