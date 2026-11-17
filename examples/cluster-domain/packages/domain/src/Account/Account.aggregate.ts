import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Actor } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { CustomerId } from "../CustomerId.ts";
import { Cents } from "../Money.ts";
import { AccountId } from "./Account.id.ts";
import { CreditTransfer, TransferCredited } from "./CreditTransfer.command.ts";
import { DebitTransfer, TransferDebited } from "./DebitTransfer.command.ts";
import { DepositMoney, MoneyDeposited } from "./DepositMoney.command.ts";
import { InsufficientFunds } from "./InsufficientFunds.rejection.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { NotOwner } from "./NotOwner.rejection.ts";
import { AccountOpened, AlreadyOpen, NotACustomer, OpenAccount } from "./OpenAccount.command.ts";
import { RefundTransfer, TransferRefunded } from "./RefundTransfer.command.ts";
import { MoneyWithdrawn, WithdrawMoney } from "./WithdrawMoney.command.ts";

const Open = Schema.TaggedStruct("Open", {
  customerId: CustomerId,
  name: Schema.String,
  balance: Cents,
});
type Open = typeof Open.Type;

const AccountState = Schema.Union([Schema.TaggedStruct("Unopened", {}), Open]);
type AccountState = typeof AccountState.Type;

/** The open account, if `actor` may act on it: its owner, or the system. */
const openFor = (s: AccountState, actor: Actor): Open | NotOpen | NotOwner =>
  s._tag !== "Open"
    ? new NotOpen()
    : actor._tag === "Customer" && actor.customerId !== s.customerId
      ? new NotOwner()
      : s;

/** The open account, if the request's actor (from the Session middleware) may act on it. */
const authorized = Effect.fn(function* (s: AccountState) {
  const o = openFor(s, yield* CurrentActor);
  if (o._tag !== "Open") return yield* o;
  return o;
});

/** Keep a balance only on an open account; decide refused everything else. */
const withBalance = (s: AccountState, balance: number): AccountState =>
  s._tag === "Open" ? { ...s, balance } : s;

/**
 * A bank account. Each command lives in its own file with the events it
 * records and the rejections only it returns; this file holds the state and
 * how commands and events change it.
 */
export class Account extends Domain.Aggregate("Account", {
  id: AccountId,
  state: AccountState,
  initial: { _tag: "Unopened" },
  commands: [
    OpenAccount,
    DepositMoney,
    WithdrawMoney,
    DebitTransfer,
    CreditTransfer,
    RefundTransfer,
  ],
  decide: {
    OpenAccount: Effect.fn(function* (account, cmd) {
      if (account._tag !== "Unopened") return yield* new AlreadyOpen();
      const actor = yield* CurrentActor;
      if (actor._tag !== "Customer") return yield* new NotACustomer();
      return [new AccountOpened({ customerId: actor.customerId, name: cmd.name })];
    }),

    DepositMoney: Effect.fn(function* (account, cmd) {
      const o = yield* authorized(account);
      return [new MoneyDeposited({ amount: cmd.amount, balanceAfter: o.balance + cmd.amount })];
    }),

    WithdrawMoney: Effect.fn(function* (account, cmd) {
      yield* Effect.annotateCurrentSpan("bank.amount", cmd.amount);
      const o = yield* authorized(account);
      if (cmd.amount > o.balance)
        return yield* new InsufficientFunds({ balance: o.balance, requested: cmd.amount });
      return [new MoneyWithdrawn({ amount: cmd.amount, balanceAfter: o.balance - cmd.amount })];
    }),

    DebitTransfer: (account, cmd) => {
      const o = openFor(account, cmd.requestedBy);
      if (o._tag !== "Open") return o;
      if (cmd.amount > o.balance)
        return new InsufficientFunds({ balance: o.balance, requested: cmd.amount });
      return [
        new TransferDebited({
          transferId: cmd.transferId,
          amount: cmd.amount,
          balanceAfter: o.balance - cmd.amount,
        }),
      ];
    },

    CreditTransfer: (account, cmd) =>
      account._tag !== "Open"
        ? new NotOpen()
        : [
            new TransferCredited({
              transferId: cmd.transferId,
              amount: cmd.amount,
              balanceAfter: account.balance + cmd.amount,
            }),
          ],

    // A debited account is open, and accounts never close, so a refund always lands.
    RefundTransfer: (account, cmd) => [
      new TransferRefunded({
        transferId: cmd.transferId,
        amount: cmd.amount,
        balanceAfter: (account._tag === "Open" ? account.balance : 0) + cmd.amount,
      }),
    ],
  },

  evolve: {
    AccountOpened: (_, e) => ({
      _tag: "Open" as const,
      customerId: e.customerId,
      name: e.name,
      balance: 0,
    }),
    MoneyDeposited: (s, e) => withBalance(s, e.balanceAfter),
    MoneyWithdrawn: (s, e) => withBalance(s, e.balanceAfter),
    TransferDebited: (s, e) => withBalance(s, e.balanceAfter),
    TransferCredited: (s, e) => withBalance(s, e.balanceAfter),
    TransferRefunded: (s, e) => withBalance(s, e.balanceAfter),
  },

  reply: {
    DepositMoney: (s) => ({ balance: s._tag === "Open" ? s.balance : 0 }),
    WithdrawMoney: (s) => ({ balance: s._tag === "Open" ? s.balance : 0 }),
  },
}) {}
