import { AccountId } from "@bank/domain/Account/Account.id";
import { StatementLine } from "@bank/domain/Account/Statement.view";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { expect, test } from "@effect/vitest";
import * as Story from "foldkit/story";
import {
  Deliver,
  init,
  type Line,
  Message,
  type Model,
  Register,
  SaveIntents,
  shownBalance,
  update,
} from "../src/app.ts";

const earlier: Line = {
  commandId: "earlier",
  kind: "deposit",
  amount: 5_000,
  balance: 5_000,
  ack: "confirmed",
  reason: null,
};

const account: Model = {
  customerId: CustomerId.make("c-1"),
  accountId: AccountId.make("c-1-main"),
  session: "s",
  sent: 0,
  online: true,
  balance: 5_000,
  lines: [earlier],
  error: null,
};

const saved = Story.Command.resolve(SaveIntents, Message.SavedIntents());

const accepted = (commandId: string) =>
  Message.Delivered({ outcomes: [{ commandId, result: "accepted", reason: null }] });

const deposited = (commandId: string, balance: number) =>
  Message.GotLine({
    commandId,
    line: new StatementLine({ kind: "deposit", amount: 1_000, balance }),
  });

const acks = (model: Model) => model.lines.map((l) => [l.commandId, l.ack]);

// VARIANT 1: online, with optimistic UI.

test("a deposit shows at once as pending; its event confirms it", () =>
  Story.story(
    update,
    Story.given(account),
    Story.message(Message.ClickedDeposit()),
    saved,
    Story.model((model) => {
      expect(model.lines[0]).toMatchObject({ commandId: "s:0", ack: "pending", balance: null });
      expect(shownBalance(model)).toBe(6_000);
    }),
    Story.Command.resolve(Deliver, accepted("s:0")),
    saved,
    // Accepted is not acknowledged: still pending until the statement says so.
    Story.model((model) => expect(model.lines[0]!.ack).toBe("pending")),
    Story.message(deposited("s:0", 6_000)),
    saved,
    Story.model((model) => {
      expect(acks(model)).toEqual([
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
        { ...earlier, commandId: "s:0", amount: 1_000, balance: null, ack: "pending" },
        earlier,
      ],
    }),
    Story.message(deposited("s:0", 6_000)),
    saved,
    Story.message(accepted("s:0")),
    saved,
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
    saved,
    Story.model((model) => expect(shownBalance(model)).toBe(4_000)),
    Story.Command.resolve(
      Deliver,
      Message.Delivered({
        outcomes: [{ commandId: "s:0", result: "rejected", reason: "InsufficientFunds" }],
      }),
    ),
    saved,
    Story.model((model) => {
      expect(model.lines[0]).toMatchObject({ ack: "rejected", reason: "InsufficientFunds" });
      expect(shownBalance(model)).toBe(5_000);
    }),
  ));

test("an event this browser did not ask for lands below its unacknowledged lines", () =>
  Story.story(
    update,
    Story.given(account),
    Story.message(Message.ClickedDeposit()),
    saved,
    Story.Command.resolve(Deliver, accepted("s:0")),
    saved,
    // A transfer arrives from elsewhere while the deposit is in flight.
    Story.message(
      Message.GotLine({
        commandId: "transfer-t-1",
        line: new StatementLine({ kind: "transfer-in", amount: 2_000, balance: 7_000 }),
      }),
    ),
    saved,
    Story.model((model) => {
      expect(acks(model)).toEqual([
        ["s:0", "pending"],
        ["transfer-t-1", "confirmed"],
        ["earlier", "confirmed"],
      ]);
      expect(shownBalance(model)).toBe(8_000);
    }),
  ));

// VARIANT 2: offline-capable, recording intents.

test("offline, a deposit is queued; back online, it is sent and confirmed", () =>
  Story.story(
    update,
    Story.given({ ...account, online: false }),
    // Nothing is sent while offline: the intent is only kept.
    Story.message(Message.ClickedDeposit()),
    saved,
    Story.model((model) => {
      expect(model.lines[0]).toMatchObject({ commandId: "s:0", ack: "queued" });
      expect(shownBalance(model)).toBe(6_000);
    }),
    Story.message(Message.WentOnline()),
    Story.model((model) => expect(model.lines[0]!.ack).toBe("pending")),
    Story.Command.resolve(Deliver, accepted("s:0")),
    saved,
    Story.message(deposited("s:0", 6_000)),
    saved,
    Story.model((model) => expect(model.lines[0]).toMatchObject({ ack: "confirmed" })),
  ));

test("a send that cannot reach the server is queued, and so is everything after it", () =>
  Story.story(
    update,
    Story.given(account),
    Story.message(Message.ClickedDeposit()),
    saved,
    Story.Command.resolve(
      Deliver,
      Message.Delivered({ outcomes: [{ commandId: "s:0", result: "queued", reason: null }] }),
    ),
    saved,
    // A later withdrawal waits behind the queued deposit instead of overtaking it.
    Story.message(Message.ClickedWithdraw()),
    saved,
    Story.model((model) =>
      expect(acks(model)).toEqual([
        ["s:1", "queued"],
        ["s:0", "queued"],
        ["earlier", "confirmed"],
      ]),
    ),
  ));

test("a queued withdrawal the account refuses on sync stops counting", () =>
  Story.story(
    update,
    Story.given({ ...account, online: false }),
    Story.message(Message.ClickedWithdraw()),
    saved,
    Story.model((model) => expect(shownBalance(model)).toBe(4_000)),
    Story.message(Message.WentOnline()),
    Story.Command.resolve(
      Deliver,
      Message.Delivered({
        outcomes: [{ commandId: "s:0", result: "rejected", reason: "InsufficientFunds" }],
      }),
    ),
    saved,
    Story.model((model) => {
      expect(model.lines[0]).toMatchObject({ ack: "rejected", reason: "InsufficientFunds" });
      expect(shownBalance(model)).toBe(5_000);
    }),
  ));

test("intents from an earlier page load are sent, oldest first, when the app boots", () => {
  const { model, commands } = init({
    customerId: CustomerId.make("c-1"),
    session: "next",
    online: true,
    intents: [
      { commandId: "old:0", kind: "deposit", amount: 1_000 },
      { commandId: "old:1", kind: "withdrawal", amount: 500 },
    ],
  });
  expect(acks(model)).toEqual([
    ["old:1", "pending"],
    ["old:0", "pending"],
  ]);
  expect(commands).toHaveLength(1);
});

test("an intent the server already applied is confirmed by the statement's history", () =>
  Story.story(
    update,
    Story.given({
      ...account,
      lines: [
        { ...earlier, commandId: "old:0", amount: 1_000, balance: null, ack: "pending" },
        earlier,
      ],
    }),
    // The statement replays history; the earlier page load's deposit is in it.
    Story.message(deposited("old:0", 6_000)),
    saved,
    // Its resend is answered from the account's stored receipt: no second deposit.
    Story.message(accepted("old:0")),
    saved,
    Story.model((model) => {
      expect(model.lines[0]).toMatchObject({ commandId: "old:0", ack: "confirmed" });
      expect(shownBalance(model)).toBe(6_000);
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
