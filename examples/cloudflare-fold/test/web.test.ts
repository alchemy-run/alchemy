import { expect, test } from "@effect/vitest";
import * as Story from "foldkit/story";
import { AccountId } from "../src/Account/AccountId.ts";
import { StatementLine } from "../src/Account/Statement.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import {
  Deposit,
  Message,
  type Model,
  Register,
  shownBalance,
  update,
  Withdraw,
} from "../src/web/Bank.ts";

const account: Model = {
  customerId: CustomerId.make("c-1"),
  accountId: AccountId.make("c-1-main"),
  session: "s",
  sent: 0,
  balance: 5_000,
  lines: [
    {
      commandId: "earlier",
      kind: "deposit",
      amount: 5_000,
      balance: 5_000,
      ack: "confirmed",
      reason: null,
    },
  ],
  error: null,
};

test("a deposit shows at once as pending; its event confirms it", () =>
  Story.story(
    update,
    Story.given(account),
    Story.message(Message.ClickedDeposit()),
    Story.model((model) => {
      expect(model.lines[0]).toMatchObject({ commandId: "s:0", ack: "pending", balance: null });
      expect(shownBalance(model)).toBe(6_000);
    }),
    Story.Command.resolve(Deposit, Message.AcceptedCommand({ commandId: "s:0" })),
    // Accepted is not acknowledged: still pending until the statement says so.
    Story.model((model) => expect(model.lines[0]!.ack).toBe("pending")),
    Story.message(
      Message.GotLine({
        commandId: "s:0",
        line: new StatementLine({ kind: "deposit", amount: 1_000, balance: 6_000 }),
      }),
    ),
    Story.model((model) => {
      expect(model.lines.map((l) => [l.commandId, l.ack])).toEqual([
        ["s:0", "confirmed"],
        ["earlier", "confirmed"],
      ]);
      expect(shownBalance(model)).toBe(6_000);
    }),
  ));

test("the event can arrive before the reply; the reply changes nothing", () =>
  Story.story(
    update,
    // The deposit is in flight: its line is pending, its reply not yet back.
    Story.given({
      ...account,
      sent: 1,
      lines: [
        {
          commandId: "s:0",
          kind: "deposit",
          amount: 1_000,
          balance: null,
          ack: "pending",
          reason: null,
        },
        ...account.lines,
      ],
    }),
    Story.message(
      Message.GotLine({
        commandId: "s:0",
        line: new StatementLine({ kind: "deposit", amount: 1_000, balance: 6_000 }),
      }),
    ),
    Story.message(Message.AcceptedCommand({ commandId: "s:0" })),
    Story.model((model) => {
      expect(model.lines[0]).toMatchObject({ commandId: "s:0", ack: "confirmed", balance: 6_000 });
      expect(shownBalance(model)).toBe(6_000);
    }),
  ));

test("a rejected withdrawal is marked rejected and no longer moves the balance", () =>
  Story.story(
    update,
    Story.given(account),
    Story.message(Message.ClickedWithdraw()),
    Story.model((model) => expect(shownBalance(model)).toBe(4_000)),
    Story.Command.resolve(
      Withdraw,
      Message.RejectedCommand({ commandId: "s:0", reason: "InsufficientFunds" }),
    ),
    Story.model((model) => {
      expect(model.lines[0]).toMatchObject({ ack: "rejected", reason: "InsufficientFunds" });
      expect(shownBalance(model)).toBe(5_000);
    }),
  ));

test("an event this page did not send lands below its pending lines", () =>
  Story.story(
    update,
    Story.given(account),
    Story.message(Message.ClickedDeposit()),
    Story.Command.resolve(Deposit, Message.AcceptedCommand({ commandId: "s:0" })),
    // A transfer arrives from elsewhere while the deposit is in flight.
    Story.message(
      Message.GotLine({
        commandId: "transfer-t-1",
        line: new StatementLine({ kind: "transfer-in", amount: 2_000, balance: 7_000 }),
      }),
    ),
    Story.model((model) => {
      expect(model.lines.map((l) => [l.commandId, l.ack])).toEqual([
        ["s:0", "pending"],
        ["transfer-t-1", "confirmed"],
        ["earlier", "confirmed"],
      ]);
      expect(shownBalance(model)).toBe(8_000);
    }),
  ));

test("a new customer opens their account; it appears through the subscription", () =>
  Story.story(
    update,
    Story.given({ ...account, balance: null, lines: [] }),
    Story.message(Message.ClickedRegister()),
    Story.Command.resolve(Register, Message.SucceededCommand()),
    Story.model((model) => expect(model.balance).toBeNull()),
    Story.message(Message.GotBalance({ balance: 0 })),
    Story.model((model) => expect(model.balance).toBe(0)),
  ));
