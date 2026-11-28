import { AccountId } from "@bank/domain/Account/Account.id";
import { StatementLine } from "@bank/domain/Account/Statement.view";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { Component } from "@effect/ui";
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing";
import { Story } from "@effect/ui/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  BankMessage,
  BankNoDeps,
  BankUI,
  Deliver,
  History,
  HistoryMessage,
  type Line,
  type Model,
  SaveIntents,
  shownBalance,
} from "../src/Bank.ts";

const earlier: Line = {
  commandId: "earlier",
  kind: "deposit",
  amount: 5_000,
  balance: Option.some(5_000),
  ack: "Confirmed",
  reason: Option.none(),
};

const account: Model = {
  accountId: AccountId.make("c-1-main"),
  sent: 0,
  online: true,
  balance: Option.some(5_000),
  statementCursor: Option.none(),
  feedState: "Live",
  lines: [earlier],
  error: Option.none(),
  showHistory: false,
};

const props = { customerId: CustomerId.make("c-1"), session: "s", online: true, intents: [] };

/** The bank, started from `model` instead of what `init` gives. */
const bank = (model: Model = account) =>
  Story.make(BankNoDeps, props).pipe(Effect.map((s) => s.given(model)));

const accepted = (commandId: string) =>
  BankMessage.CompletedDeliver({
    outcomes: [{ commandId, result: "Accepted", reason: Option.none() }],
  });

const deposited = (commandId: string, balance: number) =>
  BankMessage.ReceivedLine({
    commandId,
    line: StatementLine.make({ kind: "deposit", amount: 1_000, balance }),
    cursor: 1,
  });

const acks = (model: Model) => model.lines.map((l) => [l.commandId, l.ack]);
const head = (model: Model) => Option.getOrThrow(Array.head(model.lines));

describe("online, with optimistic UI", () => {
  it.effect("a deposit shows at once as pending; its event confirms it", () =>
    Effect.gen(function* () {
      const s = yield* bank();
      s.send(BankMessage.ClickedDeposit()).expectExact(SaveIntents, Deliver);
      expect(head(s.model)).toMatchObject({
        commandId: "s:0",
        ack: "Pending",
        balance: Option.none(),
      });
      expect(shownBalance(s.model)).toEqual(Option.some(6_000));
      s.resolve(SaveIntents, Component.noop).resolve(Deliver, accepted("s:0"));
      s.resolve(SaveIntents, Component.noop);
      // Accepted is not acknowledged: still pending until the statement says so.
      expect(head(s.model).ack).toBe("Pending");
      s.send(deposited("s:0", 6_000)).resolve(SaveIntents, Component.noop);
      expect(acks(s.model)).toEqual([
        ["s:0", "Confirmed"],
        ["earlier", "Confirmed"],
      ]);
      expect(shownBalance(s.model)).toEqual(Option.some(6_000));
    }),
  );

  it.effect("the event can arrive before the reply; the reply changes nothing", () =>
    Effect.gen(function* () {
      // The deposit is in flight: its line is pending, its reply not yet back.
      const s = yield* bank({
        ...account,
        sent: 1,
        lines: [
          { ...earlier, commandId: "s:0", amount: 1_000, balance: Option.none(), ack: "Pending" },
          earlier,
        ],
      });
      s.send(deposited("s:0", 6_000)).resolve(SaveIntents, Component.noop);
      s.send(accepted("s:0")).resolve(SaveIntents, Component.noop);
      expect(head(s.model)).toMatchObject({
        commandId: "s:0",
        ack: "Confirmed",
        balance: Option.some(6_000),
      });
      expect(shownBalance(s.model)).toEqual(Option.some(6_000));
    }),
  );

  it.effect("a rejected withdrawal is marked rejected and no longer moves the balance", () =>
    Effect.gen(function* () {
      const s = yield* bank();
      s.send(BankMessage.ClickedWithdraw()).resolve(SaveIntents, Component.noop);
      expect(shownBalance(s.model)).toEqual(Option.some(4_000));
      s.resolve(
        Deliver,
        BankMessage.CompletedDeliver({
          outcomes: [
            { commandId: "s:0", result: "Rejected", reason: Option.some("InsufficientFunds") },
          ],
        }),
      ).resolve(SaveIntents, Component.noop);
      expect(head(s.model)).toMatchObject({
        ack: "Rejected",
        reason: Option.some("InsufficientFunds"),
      });
      expect(shownBalance(s.model)).toEqual(Option.some(5_000));
    }),
  );

  it.effect("an event this browser did not ask for lands below its unacknowledged lines", () =>
    Effect.gen(function* () {
      const s = yield* bank();
      s.send(BankMessage.ClickedDeposit())
        .resolve(SaveIntents, Component.noop)
        .resolve(Deliver, accepted("s:0"))
        .resolve(SaveIntents, Component.noop);
      // A transfer arrives from elsewhere while the deposit is in flight.
      s.send(
        BankMessage.ReceivedLine({
          commandId: "transfer-t-1",
          line: StatementLine.make({ kind: "transfer-in", amount: 2_000, balance: 7_000 }),
          cursor: 1,
        }),
      ).resolve(SaveIntents, Component.noop);
      expect(acks(s.model)).toEqual([
        ["s:0", "Pending"],
        ["transfer-t-1", "Confirmed"],
        ["earlier", "Confirmed"],
      ]);
      expect(shownBalance(s.model)).toEqual(Option.some(8_000));
    }),
  );
});

describe("offline-capable, recording intents", () => {
  it.effect("offline, a deposit is queued; back online, it is sent and confirmed", () =>
    Effect.gen(function* () {
      const s = yield* bank({ ...account, online: false });
      // Nothing is sent while offline: the intent is only kept.
      s.send(BankMessage.ClickedDeposit()).expectExact(SaveIntents);
      s.resolve(SaveIntents, Component.noop);
      expect(head(s.model)).toMatchObject({ commandId: "s:0", ack: "Queued" });
      expect(shownBalance(s.model)).toEqual(Option.some(6_000));
      // While offline the app follows neither the balance nor the statement.
      expect(s.subscriptions).toEqual(["@effect/ui/html/connectivity"]);
      s.send(BankMessage.ChangedConnectivity({ online: true })).expectExact(Deliver);
      expect(head(s.model).ack).toBe("Pending");
      s.resolve(Deliver, accepted("s:0")).resolve(SaveIntents, Component.noop);
      s.send(deposited("s:0", 6_000)).resolve(SaveIntents, Component.noop);
      expect(head(s.model)).toMatchObject({ ack: "Confirmed" });
    }),
  );

  it.effect("a send that cannot reach the server is queued, and so is everything after it", () =>
    Effect.gen(function* () {
      const s = yield* bank();
      s.send(BankMessage.ClickedDeposit())
        .resolve(SaveIntents, Component.noop)
        .resolve(
          Deliver,
          BankMessage.CompletedDeliver({
            outcomes: [{ commandId: "s:0", result: "Queued", reason: Option.none() }],
          }),
        )
        .resolve(SaveIntents, Component.noop);
      // A later withdrawal waits behind the queued deposit instead of overtaking it.
      s.send(BankMessage.ClickedWithdraw()).expectExact(SaveIntents);
      s.resolve(SaveIntents, Component.noop);
      expect(acks(s.model)).toEqual([
        ["s:1", "Queued"],
        ["s:0", "Queued"],
        ["earlier", "Confirmed"],
      ]);
    }),
  );

  it.effect("a queued withdrawal the account refuses on sync stops counting", () =>
    Effect.gen(function* () {
      const s = yield* bank({ ...account, online: false });
      s.send(BankMessage.ClickedWithdraw()).resolve(SaveIntents, Component.noop);
      expect(shownBalance(s.model)).toEqual(Option.some(4_000));
      s.send(BankMessage.ChangedConnectivity({ online: true }))
        .resolve(
          Deliver,
          BankMessage.CompletedDeliver({
            outcomes: [
              { commandId: "s:0", result: "Rejected", reason: Option.some("InsufficientFunds") },
            ],
          }),
        )
        .resolve(SaveIntents, Component.noop);
      expect(head(s.model)).toMatchObject({
        ack: "Rejected",
        reason: Option.some("InsufficientFunds"),
      });
      expect(shownBalance(s.model)).toEqual(Option.some(5_000));
    }),
  );

  it.effect("intents from an earlier page load are sent, oldest first, when the app boots", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(BankNoDeps, {
        ...props,
        session: "next",
        intents: [
          { commandId: "old:0", kind: "deposit", amount: 1_000 },
          { commandId: "old:1", kind: "withdrawal", amount: 500 },
        ],
      });
      expect(acks(s.model)).toEqual([
        ["old:1", "Pending"],
        ["old:0", "Pending"],
      ]);
      s.expectExact(Deliver);
      expect(s.pending[0]!.command.args).toMatchObject({
        intents: [{ commandId: "old:0" }, { commandId: "old:1" }],
      });
      s.resolve(Deliver, accepted("old:0")).resolve(SaveIntents, Component.noop);
    }),
  );

  it.effect("an intent the server already applied is confirmed by the statement's history", () =>
    Effect.gen(function* () {
      const s = yield* bank({
        ...account,
        lines: [
          { ...earlier, commandId: "old:0", amount: 1_000, balance: Option.none(), ack: "Pending" },
          earlier,
        ],
      });
      // The statement replays history; the earlier page load's deposit is in it.
      s.send(deposited("old:0", 6_000)).resolve(SaveIntents, Component.noop);
      // Its resend is answered from the account's stored receipt: no second deposit.
      s.send(accepted("old:0")).resolve(SaveIntents, Component.noop);
      expect(head(s.model)).toMatchObject({ commandId: "old:0", ack: "Confirmed" });
      expect(shownBalance(s.model)).toEqual(Option.some(6_000));
    }),
  );

  it.effect("a denied line allows new intents and retries with the same id", () =>
    Effect.gen(function* () {
      const denied = {
        ...account,
        lines: [
          {
            ...earlier,
            commandId: "denied",
            ack: "Denied" as const,
            reason: Option.some("MfaRequired"),
          },
          earlier,
        ],
      };
      const deposit = yield* bank(denied);
      deposit.send(BankMessage.ClickedDeposit()).expectExact(SaveIntents, Deliver);
      expect(head(deposit.model).ack).toBe("Pending");
      deposit.resolve(SaveIntents, Component.noop).resolve(Deliver, accepted("s:0"));
      deposit.resolve(SaveIntents, Component.noop);

      const retry = yield* bank(denied);
      retry
        .send(BankMessage.ClickedRetryLine({ commandId: "denied" }))
        .expectExact(SaveIntents, Deliver);
      expect(head(retry.model)).toMatchObject({
        commandId: "denied",
        ack: "Pending",
        reason: Option.none(),
      });
      expect(
        retry.pending.find((p) => p.command.name === "bank/Deliver")?.command.args,
      ).toMatchObject({
        intents: [{ commandId: "denied" }],
      });
      retry.resolve(SaveIntents, Component.noop).resolve(Deliver, accepted("denied"));
      retry.resolve(SaveIntents, Component.noop);
    }),
  );
});

describe("the account and its feeds", () => {
  it.effect("a new customer opens their account; it appears through the subscription", () =>
    Effect.gen(function* () {
      const s = yield* bank({ ...account, balance: Option.none(), lines: [] });
      s.send(BankMessage.ClickedRegister()).resolve(BankUI.RegisterCustomer, {
        commandId: "c-1",
        reply: undefined,
        receipt: { stream: "Customer/c-1", version: 1 },
        commits: [
          { stream: "Customer/c-1", version: 1 },
          { stream: "UsernameClaim/c-1", version: 1 },
        ],
      });
      expect(s.model.balance).toEqual(Option.none());
      s.send(BankMessage.ReceivedBalance({ balance: Option.some(0) }));
      expect(s.model.balance).toEqual(Option.some(0));
    }),
  );

  it.effect("a failed registration says why", () =>
    Effect.gen(function* () {
      const s = yield* bank({ ...account, balance: Option.none(), lines: [] });
      s.send(BankMessage.ClickedRegister()).fail(BankUI.RegisterCustomer, {
        _tag: "Unknown",
        commandId: "c-1",
      });
      expect(s.model.error).toEqual(Option.some("Unknown"));
    }),
  );

  it.effect("a caught-up marker records the cursor and live status", () =>
    Effect.gen(function* () {
      const s = yield* bank({ ...account, feedState: "CatchingUp" });
      s.send(BankMessage.CaughtUpStatement({ cursor: 5 }));
      expect(s.model.statementCursor).toEqual(Option.some(5));
      expect(s.model.feedState).toBe("Live");
    }),
  );

  it.effect("online, it follows the balance and the statement after its cursor", () =>
    Effect.gen(function* () {
      const s = yield* bank();
      expect(s.subscriptions).toHaveLength(3);
    }),
  );
});

// The ledger, read through the AccountLedger query a page at a time.

const row = (id: string, amount: number) => ({
  id,
  accountId: "c-1-main",
  kind: "MoneyDeposited",
  amount,
  balanceAfter: amount,
  at: 1,
});
const rows = HtmlLocator.role("list", { name: "History" });

describe("History", () => {
  it.effect("reads the ledger a page at a time and appends the next page", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(History, { accountId: account.accountId });
      s.loaded("ledger", [{ entries: [row("a", 100), row("b", 200)], cursor: "1:b" }])
        .expect(rows)
        .toHaveText("MoneyDeposited 1.00, balance 1.00MoneyDeposited 2.00, balance 2.00")
        .click(HtmlLocator.role("button", { name: "More" }))
        .loadedMore("ledger", { entries: [row("c", 300)], cursor: null })
        .expect(HtmlLocator.role("button", { name: "More" }))
        .toBeAbsent();
      expect(s.queryInfo[0]!.args).toEqual({ input: { account: "c-1-main" } });
    }),
  );

  it.effect("a story asks for more only through the query", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(History, { accountId: account.accountId });
      s.loaded("ledger", [{ entries: [row("a", 100)], cursor: "1:a" }]).send(
        HistoryMessage.ClickedMore(),
      );
      expect(s.loadingMore).toEqual(["ledger"]);
      s.loadedMore("ledger", { entries: [], cursor: null });
    }),
  );

  it.effect("a failed read says to try again", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(History, { accountId: account.accountId });
      s.loadFailed("ledger", { _tag: "TimedOut" })
        .expect(HtmlLocator.role("alert"))
        .toHaveText("History unavailable, try again");
    }),
  );
});
