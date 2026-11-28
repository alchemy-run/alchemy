// The tutorial's bank (parts 1–4), as much of it as Part 6's app reaches:
// the Api's commands and the AccountSummary view.
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Account.id.ts";
import { CustomerId } from "./Customer.id.ts";

export class NotOpen extends Domain.Rejection("NotOpen") {}
export class InsufficientFunds extends Domain.Rejection("InsufficientFunds") {}
export class AlreadyRegistered extends Domain.Rejection("AlreadyRegistered") {}
export class AlreadyOpen extends Domain.Rejection("AlreadyOpen") {}

export class AccountOpened extends Domain.Event("AccountOpened", { owner: Schema.String }) {}
export class MoneyDeposited extends Domain.Event("MoneyDeposited", {
  amount: Schema.Int,
  balanceAfter: Schema.Int,
}) {}
export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {
  amount: Schema.Int,
  balanceAfter: Schema.Int,
}) {}
export class CustomerRegistered extends Domain.Event("CustomerRegistered", {
  name: Schema.String,
}) {}

export class OpenAccount extends Domain.Command("OpenAccount", {
  input: { accountId: AccountId, owner: Schema.String },
  events: [AccountOpened],
  rejects: [AlreadyOpen],
}) {}
export class DepositMoney extends Domain.Command("DepositMoney", {
  input: { accountId: AccountId, amount: Schema.Int },
  events: [MoneyDeposited],
  rejects: [NotOpen],
  reply: { balance: Schema.Int },
}) {}
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
  input: { accountId: AccountId, amount: Schema.Int },
  events: [MoneyWithdrawn],
  rejects: [NotOpen, InsufficientFunds],
  reply: { balance: Schema.Int },
}) {}
export class RegisterCustomer extends Domain.Command("RegisterCustomer", {
  input: { customerId: CustomerId, name: Schema.String },
  events: [CustomerRegistered],
  rejects: [AlreadyRegistered],
}) {}

const State = Schema.Union([
  Schema.TaggedStruct("Unopened", {}),
  Schema.TaggedStruct("Open", { owner: Schema.String, balance: Schema.Int }),
]);

export class Account extends Domain.Aggregate("Account", {
  id: AccountId,
  state: State,
  initial: { _tag: "Unopened" },
  commands: [OpenAccount, DepositMoney, WithdrawMoney],
  keyOf: (cmd) => cmd.accountId,
  decide: {
    OpenAccount: (account, cmd) =>
      account._tag !== "Unopened" ? new AlreadyOpen() : [new AccountOpened({ owner: cmd.owner })],
    DepositMoney: (account, cmd) =>
      account._tag !== "Open"
        ? new NotOpen()
        : [new MoneyDeposited({ amount: cmd.amount, balanceAfter: account.balance + cmd.amount })],
    WithdrawMoney: (account, cmd) =>
      account._tag !== "Open"
        ? new NotOpen()
        : account.balance < cmd.amount
          ? new InsufficientFunds()
          : [
              new MoneyWithdrawn({
                amount: cmd.amount,
                balanceAfter: account.balance - cmd.amount,
              }),
            ],
  },
  evolve: {
    AccountOpened: (_, e) => ({ _tag: "Open" as const, owner: e.owner, balance: 0 }),
    MoneyDeposited: (s, e) => (s._tag === "Open" ? { ...s, balance: e.balanceAfter } : s),
    MoneyWithdrawn: (s, e) => (s._tag === "Open" ? { ...s, balance: e.balanceAfter } : s),
  },
  reply: {
    DepositMoney: (s) => ({ balance: s._tag === "Open" ? s.balance : 0 }),
    WithdrawMoney: (s) => ({ balance: s._tag === "Open" ? s.balance : 0 }),
  },
}) {}

export class Customer extends Domain.Aggregate("Customer", {
  id: CustomerId,
  state: Schema.Struct({ name: Schema.NullOr(Schema.String) }),
  initial: { name: null },
  commands: [RegisterCustomer],
  keyOf: (cmd) => cmd.customerId,
  decide: {
    RegisterCustomer: (customer, cmd) =>
      customer.name !== null
        ? new AlreadyRegistered()
        : [new CustomerRegistered({ name: cmd.name })],
  },
  evolve: {
    CustomerRegistered: (_, e) => ({ name: e.name }),
  },
}) {}

export class AccountSummary extends Domain.View("AccountSummary", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ owner: Schema.NullOr(Schema.String), balance: Schema.Int }),
  initial: { owner: null, balance: 0 },
  evolve: {
    AccountOpened: (v, e) => ({ ...v, owner: e.owner }),
    MoneyDeposited: (v, e) => ({ ...v, balance: e.balanceAfter }),
    MoneyWithdrawn: (v, e) => ({ ...v, balance: e.balanceAfter }),
  },
}) {}

export class Bank extends Domain.Model("TutorialBank", {
  aggregates: [Account, Customer],
  views: [AccountSummary],
}) {}
