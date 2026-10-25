import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------- a described wallet

const WalletId = Schema.String.pipe(Schema.brand("WalletId"));

class Deposited extends Domain.Event("Deposited", {
  amount: Schema.Number,
  balance: Schema.Number,
}) {}

class Deposit extends Domain.Command("Deposit", {
  target: WalletId,
  input: { amount: Schema.Number, at: Schema.DateTimeUtcFromString },
  events: [Deposited],
  reply: { balance: Schema.Number },
  description: "Put money into a wallet. The amount is in cents.",
  // The wire form: a branded id and a date are plain strings.
  examples: [{ target: "w-1", amount: 500, at: "2026-10-25T00:00:00.000Z" }],
}) {}

class Close extends Domain.Command("Close", { target: WalletId }) {}

class Wallet extends Domain.Aggregate("Wallet", {
  id: WalletId,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit, Close],
  decide: {
    Deposit: (s, cmd) => [new Deposited({ amount: cmd.amount, balance: s.balance + cmd.amount })],
    Close: () => [],
  },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
  reply: { Deposit: (s) => ({ balance: s.balance }) },
  read: {
    description: "A wallet's balance, as its own rules keep it.",
    examples: [{ key: "w-1" }],
  },
}) {}

class Balance extends Domain.View("Balance", {
  from: [Wallet],
  key: Wallet,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
  description: "The current balance of one wallet.",
  examples: [{ key: "w-1" }],
}) {}

class BalanceChanged extends Domain.Event("BalanceChanged", { balance: Schema.Number }) {}

class BalanceLog extends Domain.Stream("BalanceLog", {
  key: Wallet,
  entries: [BalanceChanged],
  description: "Every balance a wallet had, oldest first.",
  examples: [{ key: "w-1" }],
}) {}

class Plain extends Domain.View("Plain", {
  from: [Wallet],
  key: Wallet,
}) {}

class Wallets extends Domain.Model("Wallets", {
  aggregates: [Wallet],
  views: [Balance],
}) {}

class WalletApi extends Domain.Api("WalletApi", Deposit, Wallet, Balance) {}

describe("Domain description", () => {
  it("reads the description each kind of Api entry declares", () => {
    expect(Domain.descriptionOf(Deposit)).toBe("Put money into a wallet. The amount is in cents.");
    expect(Domain.descriptionOf(Wallet)).toBe("A wallet's balance, as its own rules keep it.");
    expect(Domain.descriptionOf(Balance)).toBe("The current balance of one wallet.");
    expect(Domain.descriptionOf(BalanceLog)).toBe("Every balance a wallet had, oldest first.");
  });

  it("reads the examples each kind of Api entry declares, in wire form", () => {
    expect(Domain.examplesOf(Deposit)).toEqual([
      { target: "w-1", amount: 500, at: "2026-10-25T00:00:00.000Z" },
    ]);
    expect(Domain.examplesOf(Wallet)).toEqual([{ key: "w-1" }]);
    expect(Domain.examplesOf(Balance)).toEqual([{ key: "w-1" }]);
    expect(Domain.examplesOf(BalanceLog)).toEqual([{ key: "w-1" }]);
  });

  it("an entry that declares nothing has no description and no examples", () => {
    expect(Domain.descriptionOf(Close)).toBeUndefined();
    expect(Domain.examplesOf(Close)).toEqual([]);
    expect(Domain.descriptionOf(Plain)).toBeUndefined();
    expect(Domain.examplesOf(Plain)).toEqual([]);
  });

  it("an example decodes with the schema the Api serves", () => {
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({ target: WalletId, amount: Schema.Number, at: Schema.DateTimeUtcFromString }),
    );
    for (const example of Domain.examplesOf(Deposit)) expect(() => decode(example)).not.toThrow();
  });

  it("types the examples from the declaration", () => {
    const deposit: ReadonlyArray<{
      readonly target: string;
      readonly amount: number;
      readonly at: string;
      readonly commandId?: string | undefined;
    }> = Domain.examplesOf(Deposit);
    const balance: ReadonlyArray<{ readonly key: string }> = Domain.examplesOf(Balance);
    // @ts-expect-error the examples are typed, not `any`
    const wrong: ReadonlyArray<{ readonly key: number }> = Domain.examplesOf(Wallet);
    expect([deposit.length, balance.length, wrong.length]).toEqual([1, 1, 1]);

    class WrongField extends Domain.Command("WrongField", {
      target: WalletId,
      input: { amount: Schema.Number },
      // @ts-expect-error an example has the command's fields only
      examples: [{ target: "w-1", amount: 1, extra: true }],
    }) {}
    class WrongType extends Domain.Command("WrongType", {
      target: WalletId,
      input: { amount: Schema.Number },
      // @ts-expect-error an example is the wire form of each field
      examples: [{ target: "w-1", amount: "1" }],
    }) {}
    class WrongKey extends Domain.View("WrongKey", {
      from: [Wallet],
      key: Wallet,
      // @ts-expect-error a read example names its key
      examples: [{ id: "w-1" }],
    }) {}
    expect([WrongField.tag, WrongType.tag, WrongKey.viewName]).toEqual([
      "WrongField",
      "WrongType",
      "WrongKey",
    ]);
  });

  it.live("a description changes nothing an Api serves", () =>
    Effect.gen(function* () {
      const api = yield* WalletApi.testClient;
      const { reply } = yield* api.Deposit({
        target: WalletId.make("w-1"),
        amount: 500,
        at: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-10-25T00:00:00.000Z"),
      });
      expect(reply.balance).toBe(500);
      const balance = yield* api.Balance.get(WalletId.make("w-1"), {
        atLeast: { stream: "Wallet/w-1", version: 1 },
      });
      expect(balance).toEqual({ balance: 500 });
      expect(yield* api.Wallet.get(WalletId.make("w-1"))).toEqual({ balance: 500 });
    }).pipe(
      Effect.scoped,
      Effect.provide(Wallets.layer(Layer.empty).pipe(Layer.provideMerge(InMemory))),
    ),
  );
});
