import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@effect/vitest";
import { Account } from "../src/Account/Account.aggregate.ts";
import { AccountSummary } from "../src/Account/AccountSummary.view.ts";
import { TransferCredited } from "../src/Account/CreditTransfer.command.ts";
import { TransferDebited } from "../src/Account/DebitTransfer.command.ts";
import { DepositMoney, MoneyDeposited } from "../src/Account/DepositMoney.command.ts";
import { InsufficientFunds } from "../src/Account/InsufficientFunds.rejection.ts";
import { NotOwner } from "../src/Account/NotOwner.rejection.ts";
import {
  AccountOpened,
  AlreadyOpen,
  NotACustomer,
  OpenAccount,
} from "../src/Account/OpenAccount.command.ts";
import { TransferRefunded } from "../src/Account/RefundTransfer.command.ts";
import { MoneyWithdrawn, WithdrawMoney } from "../src/Account/WithdrawMoney.command.ts";
import { type Actor, customer, system } from "../src/Actor.ts";
import { Bank, BankHandlers } from "../src/Bank.model.ts";
import { CurrentActor } from "../src/CurrentActor.context.ts";
import { CustomerId } from "../src/CustomerId.ts";
import { TransferCompleted } from "../src/Transfer/CompleteTransfer.command.ts";
import { TransferFailed } from "../src/Transfer/FailTransfer.command.ts";
import {
  RequestTransfer,
  SameAccount,
  TransferRequested,
} from "../src/Transfer/RequestTransfer.command.ts";
import { Transfer } from "../src/Transfer/Transfer.aggregate.ts";
import { TransferStatus } from "../src/Transfer/TransferStatus.view.ts";

const { given, provide, rejected, replied, then, view, when } = Story;

/** Act as this actor for the following commands, as the Session middleware would. */
const as = (actor: Actor) => provide(CurrentActor, actor);

const story = Story.make(Bank, { layer: BankHandlers });

const a1 = Account.ref("a-1");
const a2 = Account.ref("a-2");
const t1 = Transfer.ref("t-1");
const sam = customer("c-1");
const alex = customer("c-2");
const opened = (customerId: string, name: string) =>
  new AccountOpened({ customerId: CustomerId.make(customerId), name });

it("the model is consistent", () => {
  expect(Domain.verify(Bank)).toEqual([]);
});

it.effect("a customer opens an account for themselves", () =>
  story(
    as(sam),
    when(a1, new OpenAccount({ name: "everyday" })),
    then(a1, opened("c-1", "everyday")),
    view(AccountSummary, a1, { customerId: CustomerId.make("c-1"), name: "everyday", balance: 0 }),
  ),
);

it.effect("an account id is opened once", () =>
  story(
    given(a1, opened("c-1", "everyday")),
    as(alex),
    when(a1, new OpenAccount({ name: "mine now" })),
    rejected(new AlreadyOpen()),
  ),
);

it.effect("only a customer opens an account", () =>
  story(
    as(system("ops")),
    when(a1, new OpenAccount({ name: "everyday" })),
    rejected(new NotACustomer()),
  ),
);

it.effect("deposits and withdrawals reply with the new balance", () =>
  story(
    given(a1, opened("c-1", "everyday")),
    as(sam),
    when(a1, new DepositMoney({ amount: 100 })),
    replied({ balance: 100 }),
    when(a1, new WithdrawMoney({ amount: 30 })),
    replied({ balance: 70 }),
    then(
      a1,
      new MoneyDeposited({ amount: 100, balanceAfter: 100 }),
      new MoneyWithdrawn({ amount: 30, balanceAfter: 70 }),
    ),
    view(AccountSummary, a1, { balance: 70, movements: 2 }),
  ),
);

it.effect("an overdraft is rejected with the balance", () =>
  story(
    given(a1, opened("c-1", "everyday"), new MoneyDeposited({ amount: 50, balanceAfter: 50 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 80 })),
    rejected(new InsufficientFunds({ balance: 50, requested: 80 })),
  ),
);

it.effect("a customer can't touch someone else's account", () =>
  story(
    given(a1, opened("c-1", "everyday")),
    as(alex),
    when(a1, new DepositMoney({ amount: 10 })),
    rejected(new NotOwner()),
  ),
);

it.effect("a transfer debits the source, credits the destination and completes", () =>
  story(
    given(a1, opened("c-1", "everyday"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2", "savings")),
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
      }),
      new TransferCompleted({ transferId: t1.id }),
    ),
    then(a1, new TransferDebited({ transferId: t1.id, amount: 40, balanceAfter: 60 })),
    then(a2, new TransferCredited({ transferId: t1.id, amount: 40, balanceAfter: 40 })),
    view(TransferStatus, t1, { debited: true, credited: true, completed: true }),
  ),
);

it.effect("a transfer from someone else's account fails without moving money", () =>
  story(
    given(a1, opened("c-1", "everyday"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2", "savings")),
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
      }),
      new TransferFailed({ transferId: t1.id, reason: "not your account" }),
    ),
    view(AccountSummary, a1, { balance: 100 }),
  ),
);

it.effect("a transfer to an unopened account is refunded", () =>
  story(
    given(a1, opened("c-1", "everyday"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40 })),
    then(
      a1,
      new TransferDebited({ transferId: t1.id, amount: 40, balanceAfter: 60 }),
      new TransferRefunded({ transferId: t1.id, amount: 40, balanceAfter: 100 }),
    ),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: sam,
      }),
      new TransferFailed({ transferId: t1.id, reason: "destination account not open" }),
    ),
    view(TransferStatus, t1, { refunded: true, failedReason: "destination account not open" }),
  ),
);

it.effect("a transfer to the same account is rejected", () =>
  story(
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a1.id, amount: 40 })),
    rejected(new SameAccount()),
  ),
);
