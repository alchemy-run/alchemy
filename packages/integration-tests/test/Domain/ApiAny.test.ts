import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
class Closed extends Domain.Event("Closed") {}

class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
  balance: Schema.Number,
  requested: Schema.Number,
}) {}
class AccountClosed extends Domain.Rejection("AccountClosed") {}

class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
  rejects: [AccountClosed],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
  rejects: [InsufficientFunds, AccountClosed],
}) {}
class Close extends Domain.Command("Close", { target: Schema.String, events: [Closed] }) {}

class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number, closed: Schema.Boolean }),
  initial: { balance: 0, closed: false },
  commands: [Deposit, Withdraw, Close],
  decide: {
    Deposit: (s, { amount }) => (s.closed ? new AccountClosed() : [new Deposited({ amount })]),
    Withdraw: (s, { amount }) =>
      s.closed
        ? new AccountClosed()
        : amount > s.balance
          ? new InsufficientFunds({ balance: s.balance, requested: amount })
          : [new Withdrawn({ amount })],
    Close: (s) => (s.closed ? [] : [new Closed()]),
  },
  evolve: {
    Deposited: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    Withdrawn: (s, e) => ({ ...s, balance: s.balance - e.amount }),
    Closed: (s) => ({ ...s, closed: true }),
  },
  read: {},
}) {}

class Bank extends Domain.Model("Bank", { aggregates: [Account] }) {}

class BankApi extends Domain.Api("BankApi", Deposit, Account, Withdraw) {}
class CloseApi extends Domain.Api("CloseApi", Close, Account) {}

/** A helper written once for every Api: the tags of its commands. */
const tagsOf = <A extends Domain.Api.Any>(api: A): ReadonlyArray<Domain.Api.CommandsOf<A>["tag"]> =>
  Domain.Api.commandsOf(api).map((command) => command.tag);

describe("Domain Api.Any", () => {
  it.effect("a concrete Api is an Api.Any", () =>
    Effect.sync(() => {
      const any: Domain.Api.Any = BankApi;
      const tags: ReadonlyArray<"Deposit" | "Withdraw"> = tagsOf(BankApi);
      expect(any.apiName).toBe("BankApi");
      expect(tags).toEqual(["Deposit", "Withdraw"]);
    }),
  );

  it.effect("commandsOf gives the command classes, in the order the Api lists them", () =>
    Effect.sync(() => {
      expect(Domain.Api.commandsOf(BankApi)).toEqual([Deposit, Withdraw]);
      expect(Domain.Api.commandsOf(CloseApi)).toEqual([Close]);
    }),
  );

  it.effect("rejectionSchema decodes every declared rejection to its class", () =>
    Effect.sync(() => {
      const Rejection = Domain.Api.rejectionSchema(BankApi);
      const decoded = Schema.decodeUnknownSync(Rejection)({
        _tag: "InsufficientFunds",
        balance: 1,
        requested: 5,
      });
      const typed: InsufficientFunds | AccountClosed = decoded;
      // @ts-expect-error a union member is not one rejection
      const narrow: InsufficientFunds = decoded;
      expect(narrow).toBe(typed);
      expect(decoded).toBeInstanceOf(InsufficientFunds);
      expect(decoded).toMatchObject({ balance: 1, requested: 5 });
      expect(Schema.decodeUnknownSync(Rejection)({ _tag: "AccountClosed" })).toBeInstanceOf(
        AccountClosed,
      );
      // AccountClosed is declared by two commands, and is in the union once.
      expect((Rejection as unknown as Schema.Union<ReadonlyArray<Schema.Top>>).members).toEqual([
        AccountClosed,
        InsufficientFunds,
      ]);
      expect(() => Schema.decodeUnknownSync(Rejection)({ _tag: "Closed" })).toThrow();
    }),
  );

  it.effect("an Api whose commands never reject has Schema.Never", () =>
    Effect.sync(() => {
      const Rejection: typeof Schema.Never = Domain.Api.rejectionSchema(CloseApi);
      expect(Rejection).toBe(Schema.Never);
    }),
  );

  it.live("a rejection from the client is a member of the schema", () =>
    Effect.gen(function* () {
      const bank: Domain.Api.ClientOf<typeof BankApi> = yield* BankApi.Client;
      const isRejection = Schema.is(Domain.Api.rejectionSchema(BankApi));
      const refused = yield* bank.Withdraw({ target: "a-1", amount: 5 }).pipe(Effect.flip);
      expect(isRejection(refused)).toBe(true);
      expect(refused).toBeInstanceOf(InsufficientFunds);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.effect(BankApi.Client, BankApi.testClient).pipe(
          Layer.provide(Bank.layer(Layer.empty).pipe(Layer.provide(InMemory))),
        ),
      ),
    ),
  );
});
