import { Aggregate } from "alchemy/Fold";
import * as DateTime from "effect/DateTime";
import * as Optic from "effect/Optic";
import * as Schema from "effect/Schema";
import type { Actor } from "../Actor.ts";
import { CustomerId } from "../Customer/CustomerId.ts";
import { Cents } from "../Money.ts";
import { AccountId } from "./AccountId.ts";
import { ChangeOwner, NotPermitted, OwnerChanged } from "./ChangeOwner.ts";
import { AccountClosed, BalanceNotZero, Close } from "./Close.ts";
import { CreditTransfer, TransferCredited } from "./CreditTransfer.ts";
import { DebitTransfer, TransferDebited } from "./DebitTransfer.ts";
import { Deposit, MoneyDeposited } from "./Deposit.ts";
import { AccountFrozen, Freeze } from "./Freeze.ts";
import { Frozen } from "./Frozen.ts";
import { InsufficientFunds } from "./InsufficientFunds.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";
import { AccountOpened, AlreadyOpen, OpenAccount } from "./OpenAccount.ts";
import {
  RecordSettlement,
  SettlementOnClosedAccount,
  SettlementReceived,
} from "./RecordSettlement.ts";
import { RefundStranded, RefundTransfer, TransferRefunded } from "./RefundTransfer.ts";
import { DAILY_LIMIT, DailyLimitExceeded, MoneyWithdrawn, Withdraw } from "./Withdraw.ts";

const Open = Schema.TaggedStruct("Open", {
  customerId: CustomerId,
  owner: Schema.String,
  balance: Cents,
  frozen: Schema.NullOr(Schema.String),
  today: Schema.Struct({ day: Schema.String, withdrawn: Cents }),
});
type Open = typeof Open.Type;

const AccountState = Schema.Union([
  Schema.TaggedStruct("Unopened", {}),
  Open,
  Schema.TaggedStruct("Closed", {}),
]);
type AccountState = typeof AccountState.Type;

// Lenses on the narrowed Open state: they cannot miss, so nothing is hidden.
const balance = Optic.id<Open>().key("balance");
const frozen = Optic.id<Open>().key("frozen");

// decide helper: the narrowed state, or why the actor may not act on it.
const openFor = (s: AccountState, by: Actor): Open | NotOpen | NotOwner =>
  s._tag !== "Open"
    ? new NotOpen()
    : by._tag === "Customer" && by.customerId !== s.customerId
      ? new NotOwner()
      : s;

// evolve guard: an event in the wrong state is a bug, so the command rolls back.
const mustBeOpen = (s: AccountState, what: string): Open => {
  if (s._tag !== "Open") throw new Error(`${what} in state ${s._tag}`);
  return s;
};

const dayOf = (t: DateTime.Utc) => DateTime.formatIsoDate(t);

/**
 * A bank account. Each command lives in its own file with the events it
 * records and the rejections only it returns; this file holds the state and
 * how commands and events change it.
 */
export class Account extends Aggregate.make("Account", {
  id: AccountId,
  state: AccountState,
  initial: { _tag: "Unopened" },
  commands: [
    OpenAccount,
    ChangeOwner,
    Deposit,
    Withdraw,
    Freeze,
    Close,
    DebitTransfer,
    CreditTransfer,
    RefundTransfer,
    RecordSettlement,
  ],
  decide: {
    OpenAccount: (s, cmd) =>
      s._tag !== "Unopened"
        ? new AlreadyOpen()
        : [new AccountOpened({ customerId: cmd.customerId, owner: cmd.owner })],

    ChangeOwner: (s, cmd) =>
      s._tag !== "Open"
        ? new NotOpen()
        : cmd.by._tag !== "Agent"
          ? new NotPermitted()
          : [new OwnerChanged({ previous: s.customerId, customerId: cmd.customerId, by: cmd.by })],

    Deposit: (s, cmd) => {
      const o = openFor(s, cmd.by);
      if (o._tag !== "Open") return o;
      return [new MoneyDeposited({ amount: cmd.amount, balanceAfter: o.balance + cmd.amount })];
    },

    Withdraw: (s, cmd, { now }) => {
      const o = openFor(s, cmd.by);
      if (o._tag !== "Open") return o;
      if (o.frozen) return new Frozen({ reason: o.frozen });
      if (cmd.amount > o.balance)
        return new InsufficientFunds({ balance: o.balance, requested: cmd.amount });
      const used = o.today.day === dayOf(now) ? o.today.withdrawn : 0;
      if (used + cmd.amount > DAILY_LIMIT)
        return new DailyLimitExceeded({ remaining: DAILY_LIMIT - used });
      return [new MoneyWithdrawn({ amount: cmd.amount, balanceAfter: o.balance - cmd.amount })];
    },

    Freeze: (s, cmd) => {
      const o = openFor(s, cmd.by);
      if (o._tag !== "Open") return o;
      return o.frozen ? [] : [new AccountFrozen({ reason: cmd.reason, by: cmd.by })];
    },

    Close: (s, cmd) => {
      const o = openFor(s, cmd.by);
      if (o._tag !== "Open") return o;
      return o.balance !== 0 ? new BalanceNotZero({ balance: o.balance }) : [new AccountClosed()];
    },

    DebitTransfer: (s, cmd) => {
      const o = openFor(s, cmd.by);
      if (o._tag !== "Open") return o;
      if (o.frozen) return new Frozen({ reason: o.frozen });
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

    CreditTransfer: (s, cmd) =>
      s._tag !== "Open"
        ? new NotOpen()
        : [
            new TransferCredited({
              transferId: cmd.transferId,
              amount: cmd.amount,
              balanceAfter: s.balance + cmd.amount,
            }),
          ],

    RefundTransfer: (s, cmd) =>
      s._tag === "Open"
        ? [
            new TransferRefunded({
              transferId: cmd.transferId,
              amount: cmd.amount,
              balanceAfter: s.balance + cmd.amount,
            }),
          ]
        : [new RefundStranded({ transferId: cmd.transferId, amount: cmd.amount })],

    RecordSettlement: (s, cmd) =>
      s._tag === "Open"
        ? [
            new SettlementReceived({
              settlementId: cmd.settlementId,
              amount: cmd.amount,
              balanceAfter: s.balance + cmd.amount,
            }),
          ]
        : [new SettlementOnClosedAccount({ settlementId: cmd.settlementId, amount: cmd.amount })],
  },

  evolve: {
    AccountOpened: (_, e) => ({
      _tag: "Open" as const,
      customerId: e.customerId,
      owner: e.owner,
      balance: 0,
      frozen: null,
      today: { day: "", withdrawn: 0 },
    }),
    OwnerChanged: (s, e) => ({ ...mustBeOpen(s, "OwnerChanged"), customerId: e.customerId }),
    MoneyDeposited: (s, e) => balance.replace(e.balanceAfter, mustBeOpen(s, "MoneyDeposited")),
    TransferDebited: (s, e) => balance.replace(e.balanceAfter, mustBeOpen(s, "TransferDebited")),
    TransferCredited: (s, e) => balance.replace(e.balanceAfter, mustBeOpen(s, "TransferCredited")),
    TransferRefunded: (s, e) => balance.replace(e.balanceAfter, mustBeOpen(s, "TransferRefunded")),
    SettlementReceived: (s, e) =>
      balance.replace(e.balanceAfter, mustBeOpen(s, "SettlementReceived")),
    MoneyWithdrawn: (s, e, { at }) => {
      const o = mustBeOpen(s, "MoneyWithdrawn");
      const day = dayOf(at);
      const withdrawn = (o.today.day === day ? o.today.withdrawn : 0) + e.amount;
      return { ...balance.replace(e.balanceAfter, o), today: { day, withdrawn } };
    },
    AccountFrozen: (s, e) => frozen.replace(e.reason, mustBeOpen(s, "AccountFrozen")),
    AccountClosed: () => ({ _tag: "Closed" as const }),
    RefundStranded: (s) => s,
    SettlementOnClosedAccount: (s) => s,
  },

  reply: {
    Deposit: (s) => ({ balance: balance.get(mustBeOpen(s, "Deposit reply")) }),
    Withdraw: (s) => ({ balance: balance.get(mustBeOpen(s, "Withdraw reply")) }),
  },
}) {}
