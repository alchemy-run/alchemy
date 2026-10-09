import { describe, expect, it } from "@effect/vitest";
import { Story } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import {
  Account,
  AccountClosed,
  AccountFrozen,
  AccountOpened,
  ChangeOwner,
  Close,
  DailyLimitExceeded,
  Freeze,
  Frozen,
  InsufficientFunds,
  MoneyDeposited,
  MoneyWithdrawn,
  NotOwner,
  NotPermitted,
  OwnerChanged,
  RecordSettlement,
  SettlementOnClosedAccount,
  TransferCredited,
  TransferDebited,
  TransferRefunded,
  Withdraw,
} from "../src/Account/Account.ts";
import { AccountActivity } from "../src/Account/AccountActivity.ts";
import { mainAccountId } from "../src/Account/AccountId.ts";
import { AccountSummary } from "../src/Account/AccountSummary.ts";
import { Statement } from "../src/Account/Statement.ts";
import { agent, customer, system } from "../src/Actor.ts";
import { Bank, BankPolicies } from "../src/Bank.ts";
import { Customer, CustomerRegistered, Register } from "../src/Customer/Customer.ts";
import { CustomerDashboard } from "../src/Customer/CustomerDashboard.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import { FraudCheck } from "../src/Fraud/FraudCheck.ts";
import { Payments } from "../src/Settlement/Payments.ts";
import { AccountTransfers } from "../src/Transfer/AccountTransfers.ts";
import {
  RequestTransfer,
  Transfer,
  TransferCompleted,
  TransferFailed,
  TransferRequested,
} from "../src/Transfer/Transfer.ts";
import { TransferStatus } from "../src/Transfer/TransferStatus.ts";

const { clock, expectCall, feed, given, rejected, replied, resolve, state, then, view, when } =
  Story;

const story = Story.make(Bank, { layer: BankPolicies, ports: [FraudCheck, Payments] });

const a1 = Account.ref("a-1");
const a2 = Account.ref("a-2");
const c1 = Customer.ref("c-1");
const c2 = Customer.ref("c-2");
const t1 = Transfer.ref("t-1");
const sam = customer("c-1");
const alex = customer("c-2");
const opened = (customerId = "c-1") =>
  new AccountOpened({ customerId: CustomerId.make(customerId), owner: "sam" });

it.effect("registering opens a main account (a pure policy runs for real)", () =>
  story(
    when(c1, new Register({ name: "sam" })),
    then(c1, new CustomerRegistered({ name: "sam" })),
    then(
      Account.ref(mainAccountId(CustomerId.make("c-1"))),
      new AccountOpened({ customerId: c1.id, owner: "sam" }),
    ),
    view(AccountSummary, Account.ref("c-1-main"), {
      customerId: c1.id,
      owner: "sam",
      balance: 0,
      frozen: false,
    }),
    view(CustomerDashboard, c1, (d) => expect(d.balances).toEqual({ ["c-1-main"]: 0 } as any)),
  ),
);

it.effect("withdraw replies with the new balance and updates projections", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    when(a1, new Withdraw({ amount: 30, by: sam })),
    then(a1, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
    replied({ balance: 70 }),
    view(AccountSummary, a1, { balance: 70 }),
    feed(Statement, a1, [
      { kind: "deposit", amount: 100, balance: 100 },
      { kind: "withdrawal", amount: 30, balance: 70 },
    ]),
  ),
);

it.effect("overdraft is rejected with evidence", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 50, balanceAfter: 50 })),
    when(a1, new Withdraw({ amount: 80, by: sam })),
    rejected(new InsufficientFunds({ balance: 50, requested: 80 })),
  ),
);

it.effect("a customer can't withdraw from someone else's account", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    when(a1, new Withdraw({ amount: 30, by: alex })),
    rejected(new NotOwner()),
  ),
);

it.effect("the daily limit uses the story clock", () =>
  story(
    clock("2026-10-09T09:00:00Z"),
    given(a1, opened(), new MoneyDeposited({ amount: 300_000, balanceAfter: 300_000 })),
    when(a1, new Withdraw({ amount: 40_000, by: sam })),
    when(a1, new Withdraw({ amount: 40_000, by: sam })),
    when(a1, new Withdraw({ amount: 30_000, by: sam })),
    rejected(new DailyLimitExceeded({ remaining: 20_000 })),
    clock("2026-10-10T00:00:01Z"),
    when(a1, new Withdraw({ amount: 30_000, by: sam })),
    then(
      a1,
      new MoneyWithdrawn({ amount: 40_000, balanceAfter: 260_000 }),
      new MoneyWithdrawn({ amount: 40_000, balanceAfter: 220_000 }),
      new MoneyWithdrawn({ amount: 30_000, balanceAfter: 190_000 }),
    ),
  ),
);

it.effect("freezing twice records nothing", () =>
  story(
    given(a1, opened(), new AccountFrozen({ reason: "kyc", by: agent("support-7") })),
    when(a1, new Freeze({ reason: "again", by: agent("support-7") })),
    then(a1),
    state(a1, (s) => expect(s).toMatchObject({ frozen: "kyc" })),
  ),
);

it.effect("a risky withdrawal freezes the account (a Port call suspends until resolved)", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 90_000, balanceAfter: 90_000 })),
    when(a1, new Withdraw({ amount: 60_000, by: sam })),
    then(a1, new MoneyWithdrawn({ amount: 60_000, balanceAfter: 30_000 })),
    expectCall(FraudCheck.score, { accountId: a1.id, amount: 60_000 }),
    resolve(FraudCheck.score, { risk: 0.95 }),
    then(a1, new AccountFrozen({ reason: "fraud risk 0.95", by: system("FraudReview") })),
    when(a1, new Withdraw({ amount: 10, by: sam })),
    rejected(new Frozen({ reason: "fraud risk 0.95" })),
  ),
);

it.effect("race: the account is closed while the fraud check is pending", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 60_000, balanceAfter: 60_000 })),
    when(a1, new Withdraw({ amount: 60_000, by: sam })),
    expectCall(FraudCheck.score, { accountId: a1.id, amount: 60_000 }),
    when(a1, new Close({ by: sam })),
    then(a1, new MoneyWithdrawn({ amount: 60_000, balanceAfter: 0 }), new AccountClosed()),
    resolve(FraudCheck.score, { risk: 0.95 }),
    then(a1),
    view(AccountSummary, a1, Story.none),
  ),
);

it.effect("a transfer completes: the process manager drives both accounts", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2")),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40, by: sam })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: sam,
      }),
    ),
    then(a1, new TransferDebited({ transferId: t1.id, amount: 40, balanceAfter: 60 })),
    then(a2, new TransferCredited({ transferId: t1.id, amount: 40, balanceAfter: 40 })),
    then(t1, new TransferCompleted({ transferId: t1.id })),
    view(TransferStatus, t1, (v) => expect(TransferStatus.computed.status(v)).toBe("completed")),
    feed(AccountTransfers, a1, [{ transferId: t1.id, amount: 40, direction: "out" }]),
    feed(AccountTransfers, a2, [{ transferId: t1.id, amount: 40, direction: "in" }]),
  ),
);

it.effect("a customer can't move money out of someone else's account with a transfer", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2")),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40, by: alex })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: alex,
      }),
    ),
    then(a1),
    then(t1, new TransferFailed({ transferId: t1.id, reason: "not your account" })),
  ),
);

it.effect("a transfer to a closed account is compensated", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2"), new AccountClosed()),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40, by: sam })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: sam,
      }),
    ),
    then(
      a1,
      new TransferDebited({ transferId: t1.id, amount: 40, balanceAfter: 60 }),
      new TransferRefunded({ transferId: t1.id, amount: 40, balanceAfter: 100 }),
    ),
    then(t1, new TransferFailed({ transferId: t1.id, reason: "destination account not open" })),
    view(TransferStatus, t1, { amount: 40, debited: true, credited: false, refunded: true }),
  ),
);

it.effect("a settlement on a closed account can't be rejected, so it is refunded", () =>
  story(
    given(a1, opened(), new AccountClosed()),
    when(a1, new RecordSettlement({ settlementId: "st_1", amount: 500 })),
    then(a1, new SettlementOnClosedAccount({ settlementId: "st_1", amount: 500 })),
    expectCall(Payments.refund, { settlementId: "st_1", amount: 500 }),
    resolve(Payments.refund, { refundId: "re_1" }),
    feed(AccountActivity, a1, (entries) =>
      expect(entries.at(-1)?.event._tag).toBe("SettlementOnClosedAccount"),
    ),
  ),
);

it.effect("only agents reassign accounts, and the dashboards re-key", () =>
  story(
    given(c1, new CustomerRegistered({ name: "sam" })),
    given(c2, new CustomerRegistered({ name: "alex" })),
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    view(CustomerDashboard, c1, (d) => expect(d.balances).toEqual({ ["a-1"]: 100 } as any)),
    when(a1, new ChangeOwner({ customerId: c2.id, by: sam })),
    rejected(new NotPermitted()),
    when(a1, new ChangeOwner({ customerId: c2.id, by: agent("support-7") })),
    then(a1, new OwnerChanged({ customerId: c2.id, by: agent("support-7") })),
    view(CustomerDashboard, c1, (d) => expect(d.balances).toEqual({} as any)),
    view(CustomerDashboard, c2, (d) =>
      expect(CustomerDashboard.computed.totalBalance(d)).toBe(100),
    ),
  ),
);

it.effect("an unasserted rejection fails the story", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 1, balanceAfter: 1 })),
    when(a1, new Withdraw({ amount: 5, by: sam })),
  ).pipe(
    Effect.flip,
    Effect.map((failure) => expect(failure.message).toMatch(/InsufficientFunds/)),
  ),
);

it.effect("an unresolved Port call fails the story", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 90_000, balanceAfter: 90_000 })),
    when(a1, new Withdraw({ amount: 60_000, by: sam })),
  ).pipe(
    Effect.flip,
    Effect.map((failure) => expect(failure.message).toMatch(/unresolved Port calls/)),
  ),
);
