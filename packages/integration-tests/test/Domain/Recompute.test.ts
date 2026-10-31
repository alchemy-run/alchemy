import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: { Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

const Amounts = Schema.Struct({ amounts: Schema.Array(Schema.Number) });

/** Every deposit to an account, in the order the view applied them. */
class Deposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Amounts,
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount] }) },
}) {}

/** The same view, with a new `evolve`: it records each deposit doubled. */
class DoubledDeposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Amounts,
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount * 2] }) },
}) {}

/** A view of `Deposits`: the amounts it held after its latest change. */
class Latest extends Domain.View("Latest", {
  from: [Deposits],
  key: Account,
  state: Amounts,
  initial: { amounts: [] },
  evolve: { Deposited: (_, __, { state }) => ({ amounts: state?.amounts ?? [] }) },
}) {}
class LatestOfDoubled extends Domain.View("Latest", {
  from: [DoubledDeposits],
  key: Account,
  state: Amounts,
  initial: { amounts: [] },
  evolve: { Deposited: (_, __, { state }) => ({ amounts: state?.amounts ?? [] }) },
}) {}

class Bank extends Domain.Model("Bank", { aggregates: [Account], views: [Deposits] }) {}
class Redefined extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [DoubledDeposits],
}) {}
class WithLatest extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [Deposits, Latest],
}) {}
class RedefinedWithLatest extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [DoubledDeposits, LatestOfDoubled],
}) {}

/**
 * An in-memory platform that outlives the models built on it, as storage
 * outlives a deploy. `deploy` builds a model on it and runs `effect` against
 * that build, then delivers everything queued.
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
      model: { readonly layer: (policies: any, options?: any) => Layer.Layer<any, any, any> },
      effect: Effect.Effect<A, E, R>,
      options?: Domain.Model.LayerOptions,
    ) =>
      effect.pipe(
        Effect.tap(() => settle),
        Effect.provide(model.layer(Layer.empty, options).pipe(Layer.provide(hosted.layer))),
      ),
  };
};

const deposit = (id: string, amount: number) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    yield* accounts.send(Account.ref(id), new Deposit({ amount }));
  });

const amounts = (view: typeof Deposits | typeof Latest, id: string) =>
  Effect.gen(function* () {
    const client = yield* view;
    return Option.getOrUndefined(yield* client.query(Account.ref(id)))?.amounts;
  });

describe("Domain view recompute", () => {
  it.live("recomputing a view re-folds each key's own inputs through its new evolve", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Bank, Effect.all([deposit("a-1", 1), deposit("a-1", 2)]));
      const [before, history, after] = yield* bank.deploy(
        Redefined,
        Effect.gen(function* () {
          const view = yield* DoubledDeposits;
          // Nothing to replay from the history: the view is complete at once.
          const history = yield* view.history;
          const before = yield* amounts(DoubledDeposits, "a-1");
          yield* deposit("a-1", 3);
          yield* bank.settle;
          return [before, history, yield* amounts(DoubledDeposits, "a-1")] as const;
        }),
        { recompute: { Deposits: 1 } },
      );
      expect(history.complete).toBe(true);
      expect(before).toEqual([2, 4]);
      expect(after).toEqual([2, 4, 6]);
    }),
  );

  it.live("without a recompute, a redefined view keeps what it already folded", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Bank, Effect.all([deposit("a-1", 1), deposit("a-1", 2)]));
      const after = yield* bank.deploy(
        Redefined,
        Effect.gen(function* () {
          yield* deposit("a-1", 3);
          yield* bank.settle;
          return yield* amounts(DoubledDeposits, "a-1");
        }),
      );
      expect(after).toEqual([1, 2, 6]);
    }),
  );

  it.live("a view that reads a recomputed view is rebuilt from its new entries", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(WithLatest, Effect.all([deposit("a-1", 1), deposit("a-1", 2)]));
      expect(yield* bank.deploy(WithLatest, amounts(Latest, "a-1"))).toEqual([1, 2]);
      const latest = yield* bank.deploy(
        RedefinedWithLatest,
        Effect.gen(function* () {
          yield* bank.settle;
          return yield* amounts(LatestOfDoubled, "a-1");
        }),
        { recompute: { Deposits: 1 } },
      );
      expect(latest).toEqual([2, 4]);
    }),
  );
});
