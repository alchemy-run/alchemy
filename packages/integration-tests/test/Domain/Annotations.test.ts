import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

// A key of this suite's own, as an app or a library adds one.
declare module "@alchemy.run/domain" {
  interface Annotations {
    readonly annotationsTestOwner?: string;
  }
}

const WalletId = Schema.String.pipe(Schema.brand("WalletId"));

class Deposited extends Domain.Event(
  "Deposited",
  { amount: Schema.Int, balance: Schema.Int },
  { description: "Money arrived in a wallet." },
) {}

class Deposit extends Domain.Command(
  "Deposit",
  {
    target: WalletId,
    input: { amount: Schema.Int },
    events: [Deposited],
  },
  {
    description: "Put money into a wallet. The amount is in cents.",
    annotationsTestOwner: "payments",
  },
) {}

class Close extends Domain.Command("Close", { target: WalletId }) {}

class Wallet extends Domain.Aggregate(
  "Wallet",
  {
    id: WalletId,
    state: Schema.Struct({ balance: Schema.Int }),
    initial: { balance: 0 },
    commands: [Deposit, Close],
    decide: {
      Deposit: (wallet, cmd) => [
        new Deposited({ amount: cmd.amount, balance: wallet.balance + cmd.amount }),
      ],
      Close: () => [],
    },
    evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
  },
  { description: "A wallet, which keeps its own balance." },
) {}

class Balance extends Domain.View(
  "Balance",
  {
    from: [Wallet],
    key: Wallet,
    state: Schema.Struct({ balance: Schema.Int }),
    initial: { balance: 0 },
    evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
  },
  { description: "The current balance of one wallet." },
) {}

class BalanceChanged extends Domain.Event("BalanceChanged", { balance: Schema.Int }) {}

class BalanceLog extends Domain.Stream(
  "BalanceLog",
  {
    key: Wallet,
    entries: [BalanceChanged],
  },
  { description: "Every balance a wallet had, oldest first." },
) {}

class LogBalances extends Domain.Projection(
  "LogBalances",
  {
    from: [Wallet],
    key: Wallet,
    on: [Deposited],
    writes: [BalanceLog],
  },
  { description: "Logs each new balance." },
) {}

class Notify extends Domain.Policy(
  "Notify",
  {
    from: Wallet,
    on: [Deposited],
  },
  { description: "Tells the owner about a deposit." },
) {}

class Refund extends Domain.Saga(
  "Refund",
  {
    key: Schema.String,
    input: { wallet: Schema.String },
  },
  { description: "Gives a deposit back." },
) {}

class NoFunds extends Domain.Rejection(
  "NoFunds",
  {},
  { httpApiStatus: 402, description: "The wallet can't cover it." },
) {}

class Bank extends Domain.ExternalSystem(
  "Bank",
  { payout: { args: { amount: Schema.Int }, success: { reference: Schema.String } } },
  { description: "The bank that pays money out." },
) {}

class Balances extends Domain.Query(
  "Balances",
  { input: { min: Schema.Int }, success: Schema.Int, paged: true },
  { description: "Every balance of at least min." },
) {}

class Wallets extends Domain.Model(
  "Wallets",
  {
    aggregates: [Wallet],
    views: [Balance],
  },
  { description: "Wallets and their balances." },
) {}

class WalletApi extends Domain.Api(
  "WalletApi",
  {
    model: Wallets,
  },
  { description: "What a wallet app reaches." },
) {}

describe("Domain annotations", { tags: ["unit"] }, () => {
  it("every declaration carries the annotations it declares", () => {
    expect(Deposited.annotations.description).toBe("Money arrived in a wallet.");
    expect(Deposit.annotations).toEqual({
      description: "Put money into a wallet. The amount is in cents.",
      annotationsTestOwner: "payments",
    });
    expect(Wallet.annotations.description).toBe("A wallet, which keeps its own balance.");
    expect(Balance.annotations.description).toBe("The current balance of one wallet.");
    expect(BalanceLog.annotations.description).toBe("Every balance a wallet had, oldest first.");
    expect(LogBalances.annotations.description).toBe("Logs each new balance.");
    expect(Notify.annotations.description).toBe("Tells the owner about a deposit.");
    expect(Refund.annotations.description).toBe("Gives a deposit back.");
    expect(NoFunds.annotations.description).toBe("The wallet can't cover it.");
    expect(Bank.annotations.description).toBe("The bank that pays money out.");
    expect(Balances.annotations.description).toBe("Every balance of at least min.");
    expect(Wallets.annotations.description).toBe("Wallets and their balances.");
    expect(WalletApi.annotations.description).toBe("What a wallet app reaches.");
  });

  it("an event's and a rejection's annotations are their Schema's too", () => {
    expect(SchemaAST.resolveDescription(Deposited.ast)).toBe("Money arrived in a wallet.");
    expect(SchemaAST.resolveDescription(NoFunds.ast)).toBe("The wallet can't cover it.");
    expect(SchemaAST.resolveAt<number>("httpApiStatus")(NoFunds.ast)).toBe(402);
  });

  it("tooling can walk a model and read each declaration's annotations", () => {
    const glossary = Wallets.commands.map(
      (command) => `${command.tag}: ${command.annotations.description ?? "Undocumented."}`,
    );
    expect(glossary).toEqual([
      "Deposit: Put money into a wallet. The amount is in cents.",
      "Close: Undocumented.",
    ]);
  });

  it("a declaration without annotations has none", () => {
    expect(Close.annotations).toEqual({});
    expect(BalanceChanged.annotations).toEqual({});
  });

  it.effect("a key nobody declared is a type error; an augmented one is typed", () =>
    Effect.sync(() => {
      class Typo extends Domain.Command(
        "Typo",
        { target: WalletId },
        // @ts-expect-error `descripton` is not a key of Domain.Annotations
        { descripton: "misspelled" },
      ) {}
      const owner: string | undefined = Deposit.annotations.annotationsTestOwner;
      expect([Typo.tag, owner]).toEqual(["Typo", "payments"]);
    }),
  );
});
