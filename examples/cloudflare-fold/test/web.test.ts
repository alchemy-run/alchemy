import { expect, test } from "@effect/vitest";
import * as Story from "foldkit/story";
import { AccountId } from "../src/Account/AccountId.ts";
import { StatementLine } from "../src/Account/Statement.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import { Deposit, Message, type Model, Register, update, Withdraw } from "../src/web/Bank.ts";

const account: Model = {
  customerId: CustomerId.make("c-1"),
  accountId: AccountId.make("c-1-main"),
  balance: 5_000,
  lines: [],
  error: null,
};

test("depositing runs the DepositMoney command; the balance arrives by subscription", () =>
  Story.story(
    update,
    Story.given(account),
    Story.message(Message.ClickedDeposit()),
    Story.Command.resolve(Deposit, Message.SucceededCommand()),
    Story.model((model) => expect(model).toMatchObject({ balance: 5_000, error: null })),
    Story.message(Message.GotBalance({ balance: 6_000 })),
    Story.message(
      Message.GotLine({
        line: new StatementLine({ kind: "deposit", amount: 1_000, balance: 6_000 }),
      }),
    ),
    Story.model((model) => {
      expect(model.balance).toBe(6_000);
      expect(model.lines.map((line) => line.kind)).toEqual(["deposit"]);
    }),
  ));

test("a rejected withdrawal shows the rejection", () =>
  Story.story(
    update,
    Story.given(account),
    Story.message(Message.ClickedWithdraw()),
    Story.Command.resolve(Withdraw, Message.FailedCommand({ reason: "InsufficientFunds" })),
    Story.model((model) => expect(model.error).toBe("InsufficientFunds")),
  ));

test("a new customer opens their account; it appears through the subscription", () =>
  Story.story(
    update,
    Story.given({ ...account, balance: null }),
    Story.message(Message.ClickedRegister()),
    Story.Command.resolve(Register, Message.SucceededCommand()),
    Story.model((model) => expect(model.balance).toBeNull()),
    Story.message(Message.GotBalance({ balance: 0 })),
    Story.model((model) => expect(model.balance).toBe(0)),
  ));
