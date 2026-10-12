import { expect, test } from "@effect/vitest";
import * as Story from "foldkit/story";
import { AccountId } from "../src/Account/AccountId.ts";
import { StatementLine } from "../src/Account/Statement.ts";
import { Deposit, Message, type Model, update, Withdraw } from "../web/Bank.ts";

const account: Model = {
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
    Story.Command.resolve(Deposit, Message.SucceededCommand({ balance: 6_000 })),
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
