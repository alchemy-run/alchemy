import { describe, expect, it } from "@effect/vitest";
import { Story } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { Account } from "../src/Account/Account.ts";
import { AccountActivity } from "../src/Account/AccountActivity.ts";
import { mainAccountId } from "../src/Account/AccountId.ts";
import { AccountSummary } from "../src/Account/AccountSummary.ts";
import { ChangeOwner, NotPermitted, OwnerChanged } from "../src/Account/ChangeOwner.ts";
import { AccountClosed, CloseAccount } from "../src/Account/CloseAccount.ts";
import { TransferCredited } from "../src/Account/CreditTransfer.ts";
import { TransferDebited } from "../src/Account/DebitTransfer.ts";
import { MoneyDeposited } from "../src/Account/DepositMoney.ts";
import { AccountFrozen, FreezeAccount } from "../src/Account/FreezeAccount.ts";
import { Frozen } from "../src/Account/Frozen.ts";
import { InsufficientFunds } from "../src/Account/InsufficientFunds.ts";
import { NotOwner } from "../src/Account/NotOwner.ts";
import { AccountOpened } from "../src/Account/OpenAccount.ts";
import { RecordSettlement, SettlementOnClosedAccount } from "../src/Account/RecordSettlement.ts";
import { TransferRefunded } from "../src/Account/RefundTransfer.ts";
import { Statement } from "../src/Account/Statement.ts";
import { DailyLimitExceeded, MoneyWithdrawn, WithdrawMoney } from "../src/Account/WithdrawMoney.ts";
import { type Actor, agent, customer, system } from "../src/Actor.ts";
import { Bank, BankPolicies } from "../src/Bank.ts";
import { CurrentActor } from "../src/CurrentActor.ts";
import { UsernameClaimed } from "../src/Customer/ClaimUsername.ts";
import { CustomerRegistered } from "../src/Customer/ConfirmRegistration.ts";
import { Customer } from "../src/Customer/Customer.ts";
import { CustomerDashboard } from "../src/Customer/CustomerDashboard.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import { RegisterCustomer, RegistrationRequested } from "../src/Customer/RegisterCustomer.ts";
import { RegistrationRejected } from "../src/Customer/RejectRegistration.ts";
import { Username } from "../src/Customer/Username.ts";
import { UsernameClaim } from "../src/Customer/UsernameClaim.ts";
import { DailyOutflow } from "../src/Fraud/DailyOutflow.ts";
import { FraudCheck } from "../src/Fraud/FraudCheck.ts";
import { Payments } from "../src/Settlement/Payments.ts";
import { AccountTransfers } from "../src/Transfer/AccountTransfers.ts";
import {
  ApproveTransfer,
  NotAwaitingApproval,
  TransferApproved,
} from "../src/Transfer/ApproveTransfer.ts";
import { TransferCompleted } from "../src/Transfer/CompleteTransfer.ts";
import { TransferFailed } from "../src/Transfer/FailTransfer.ts";
import { RequestTransfer, TransferRequested } from "../src/Transfer/RequestTransfer.ts";
import { Transfer } from "../src/Transfer/Transfer.ts";
import { TransferStatus } from "../src/Transfer/TransferStatus.ts";

const {
  clock,
  emitted,
  expectCall,
  given,
  provide,
  rejected,
  replied,
  resolve,
  state,
  then,
  view,
  when,
} = Story;

/** Act as this actor for the following commands, as their session middleware would. */
const as = (actor: Actor) => provide(CurrentActor, actor);

const story = Story.make(Bank, { layer: BankPolicies, ports: [FraudCheck, Payments] });

const a1 = Account.ref("a-1");
const a2 = Account.ref("a-2");
const c1 = Customer.ref("c-1");
const c2 = Customer.ref("c-2");
const t1 = Transfer.ref("t-1");
const sam = customer("c-1");
const alex = customer("c-2");
const samsName = Username.make("sam");
const opened = (customerId = "c-1") =>
  new AccountOpened({ customerId: CustomerId.make(customerId), owner: "sam" });

it.effect("registering claims the username, then opens a main account", () =>
  story(
    as(sam),
    when(c1, new RegisterCustomer({ name: "sam", username: samsName })),
    then(
      c1,
      new RegistrationRequested({ name: "sam", username: samsName }),
      new CustomerRegistered({ name: "sam", username: samsName }),
    ),
    then(UsernameClaim.ref("sam"), new UsernameClaimed({ customerId: c1.id })),
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

it.effect("a taken username rejects the registration, and nothing else happens", () =>
  story(
    given(UsernameClaim.ref("sam"), new UsernameClaimed({ customerId: c1.id })),
    as(alex),
    when(c2, new RegisterCustomer({ name: "alex", username: samsName })),
    then(
      c2,
      new RegistrationRequested({ name: "alex", username: samsName }),
      new RegistrationRejected({ username: samsName, reason: "username taken" }),
    ),
    then(Account.ref(mainAccountId(CustomerId.make("c-2")))),
    // The customer can try again with another name.
    when(c2, new RegisterCustomer({ name: "alex", username: Username.make("alex") })),
    then(
      c2,
      new RegistrationRequested({ name: "alex", username: Username.make("alex") }),
      new CustomerRegistered({ name: "alex", username: Username.make("alex") }),
    ),
  ),
);

it.effect("withdraw replies with the new balance and updates projections", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 30 })),
    then(a1, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
    replied({ balance: 70 }),
    view(AccountSummary, a1, { balance: 70 }),
    emitted(Statement, a1, [
      { kind: "deposit", amount: 100, balance: 100 },
      { kind: "withdrawal", amount: 30, balance: 70 },
    ]),
  ),
);

it.effect("overdraft is rejected with evidence", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 50, balanceAfter: 50 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 80 })),
    rejected(new InsufficientFunds({ balance: 50, requested: 80 })),
  ),
);

it.effect("a customer can't withdraw from someone else's account", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    as(alex),
    when(a1, new WithdrawMoney({ amount: 30 })),
    rejected(new NotOwner()),
  ),
);

it.effect("the daily limit uses the story clock", () =>
  story(
    clock("2026-10-09T09:00:00Z"),
    given(a1, opened(), new MoneyDeposited({ amount: 300_000, balanceAfter: 300_000 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 40_000 })),
    when(a1, new WithdrawMoney({ amount: 40_000 })),
    expectCall(FraudCheck.score, { accountId: a1.id, amount: 80_000 }),
    resolve(FraudCheck.score, { risk: 0.1 }),
    when(a1, new WithdrawMoney({ amount: 30_000 })),
    rejected(new DailyLimitExceeded({ remaining: 20_000 })),
    clock("2026-10-10T00:00:01Z"),
    when(a1, new WithdrawMoney({ amount: 30_000 })),
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
    as(agent("support-7")),
    when(a1, new FreezeAccount({ reason: "again" })),
    then(a1),
    state(a1, (s) => expect(s).toMatchObject({ frozen: "kyc" })),
  ),
);

it.effect("a risky withdrawal freezes the account (a Port call suspends until resolved)", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 90_000, balanceAfter: 90_000 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 60_000 })),
    then(a1, new MoneyWithdrawn({ amount: 60_000, balanceAfter: 30_000 })),
    expectCall(FraudCheck.score, { accountId: a1.id, amount: 60_000 }),
    resolve(FraudCheck.score, { risk: 0.95 }),
    then(a1, new AccountFrozen({ reason: "fraud risk 0.95", by: system("FraudReview") })),
    when(a1, new WithdrawMoney({ amount: 10 })),
    rejected(new Frozen({ reason: "fraud risk 0.95" })),
  ),
);

it.effect(
  "split withdrawals that cross the daily threshold are reviewed (a policy on a view)",
  () =>
    story(
      given(a1, opened(), new MoneyDeposited({ amount: 90_000, balanceAfter: 90_000 })),
      as(sam),
      when(a1, new WithdrawMoney({ amount: 30_000 })),
      when(a1, new WithdrawMoney({ amount: 30_000 })),
      then(
        a1,
        new MoneyWithdrawn({ amount: 30_000, balanceAfter: 60_000 }),
        new MoneyWithdrawn({ amount: 30_000, balanceAfter: 30_000 }),
      ),
      emitted(DailyOutflow, a1, [{ day: "2026-01-01", total: 60_000 }]),
      expectCall(FraudCheck.score, { accountId: a1.id, amount: 60_000 }),
      resolve(FraudCheck.score, { risk: 0.1 }),
      then(a1),
    ),
);

it.effect("race: the account is closed while the fraud check is pending", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 60_000, balanceAfter: 60_000 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 60_000 })),
    expectCall(FraudCheck.score, { accountId: a1.id, amount: 60_000 }),
    when(a1, new CloseAccount()),
    then(a1, new MoneyWithdrawn({ amount: 60_000, balanceAfter: 0 }), new AccountClosed()),
    resolve(FraudCheck.score, { risk: 0.95 }),
    then(a1),
    view(AccountSummary, a1, { closed: true }),
  ),
);

it.effect("a transfer completes: the process manager drives both accounts", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2")),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: sam,
        needsApproval: false,
      }),
    ),
    then(a1, new TransferDebited({ transferId: t1.id, amount: 40, balanceAfter: 60 })),
    then(a2, new TransferCredited({ transferId: t1.id, amount: 40, balanceAfter: 40 })),
    then(t1, new TransferCompleted({ transferId: t1.id })),
    view(TransferStatus, t1, (v) => expect(TransferStatus.computed.status(v)).toBe("completed")),
    emitted(AccountTransfers, a1, [{ transferId: t1.id, amount: 40, direction: "out" }]),
    emitted(AccountTransfers, a2, [{ transferId: t1.id, amount: 40, direction: "in" }]),
  ),
);

it.effect("a customer can't move money out of someone else's account with a transfer", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2")),
    as(alex),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: alex,
        needsApproval: false,
      }),
    ),
    then(a1),
    then(t1, new TransferFailed({ transferId: t1.id, reason: "not your account" })),
  ),
);

it.effect("a large transfer waits for a support agent's approval", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100_000, balanceAfter: 100_000 })),
    given(a2, opened("c-2")),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 20_000 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 20_000,
        requestedBy: sam,
        needsApproval: true,
      }),
    ),
    then(a1),
    view(TransferStatus, t1, (v) =>
      expect(TransferStatus.computed.status(v)).toBe("awaiting-approval"),
    ),
    as(agent("support-7")),
    when(t1, new ApproveTransfer()),
    then(
      t1,
      new TransferApproved({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 20_000,
        requestedBy: sam,
        approvedBy: agent("support-7"),
      }),
      new TransferCompleted({ transferId: t1.id }),
    ),
    then(a1, new TransferDebited({ transferId: t1.id, amount: 20_000, balanceAfter: 80_000 })),
    then(a2, new TransferCredited({ transferId: t1.id, amount: 20_000, balanceAfter: 20_000 })),
  ),
);

it.effect("an unapproved transfer expires when its approval window closes", () =>
  story(
    clock("2026-01-01T09:00:00Z"),
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100_000, balanceAfter: 100_000 })),
    given(a2, opened("c-2")),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 20_000 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 20_000,
        requestedBy: sam,
        needsApproval: true,
      }),
    ),
    clock("2026-01-02T08:59:00Z"),
    then(t1),
    clock("2026-01-02T09:00:00Z"),
    then(t1, new TransferFailed({ transferId: t1.id, reason: "not approved in time" })),
    // Approval and expiry race on the Transfer; expiry won, so approval is too late.
    as(agent("support-7")),
    when(t1, new ApproveTransfer()),
    rejected(new NotAwaitingApproval()),
    then(a1),
  ),
);

it.effect("a transfer to a closed account is compensated", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2"), new AccountClosed()),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: sam,
        needsApproval: false,
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
    emitted(AccountActivity, a1, (entries) =>
      expect(entries.at(-1)?.event._tag).toBe("SettlementOnClosedAccount"),
    ),
  ),
);

it.effect("only agents reassign accounts, and the dashboards re-key", () =>
  story(
    given(c1, new CustomerRegistered({ name: "sam", username: samsName })),
    given(c2, new CustomerRegistered({ name: "alex", username: Username.make("alex") })),
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    view(CustomerDashboard, c1, (d) => expect(d.balances).toEqual({ ["a-1"]: 100 } as any)),
    as(sam),
    when(a1, new ChangeOwner({ customerId: c2.id })),
    rejected(new NotPermitted()),
    as(agent("support-7")),
    when(a1, new ChangeOwner({ customerId: c2.id })),
    then(a1, new OwnerChanged({ previous: c1.id, customerId: c2.id, by: agent("support-7") })),
    view(CustomerDashboard, c1, (d) => expect(d.balances).toEqual({} as any)),
    view(CustomerDashboard, c2, (d) =>
      expect(CustomerDashboard.computed.totalBalance(d)).toBe(100),
    ),
  ),
);

it.effect("an unasserted rejection fails the story", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 1, balanceAfter: 1 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 5 })),
  ).pipe(
    Effect.flip,
    Effect.map((failure) => expect(failure.message).toMatch(/InsufficientFunds/)),
  ),
);

it.effect("an unresolved Port call fails the story", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 90_000, balanceAfter: 90_000 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 60_000 })),
  ).pipe(
    Effect.flip,
    Effect.map((failure) => expect(failure.message).toMatch(/unresolved Port calls/)),
  ),
);
