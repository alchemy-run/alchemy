import type { Api } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { AccountId, mainAccountId } from "../Account/AccountId.ts";
import { StatementLine } from "../Account/Statement.ts";
import { CustomerId } from "../Customer/CustomerId.ts";
import { Username } from "../Customer/Username.ts";
import { CustomerApi } from "../CustomerApi/CustomerApi.ts";

/** The bank client this app runs on, provided by the `resources` Layer in `entry.ts`. */
type Bank = Api.ClientKey<"CustomerApi">;

/** The demo MFA code `MfaChallenge` accepts. */
const mfa = { headers: { "x-mfa-code": "000000" } };

// FLAGS: who is signed in, handed over when the app boots.

export const Flags = Schema.Struct({
  customerId: CustomerId,
  /** Unique per page load; with a counter, it names every command this page sends. */
  session: Schema.String,
});
export type Flags = typeof Flags.Type;

// MODEL

/**
 * Whether the server has acknowledged a line: `pending` until the event it
 * caused arrives on the statement stream, then `confirmed`; `rejected` if the
 * account refused the command.
 */
export const Ack = Schema.Literals(["pending", "confirmed", "rejected"]);
export type Ack = typeof Ack.Type;

/** A statement line, shown before the server has acknowledged it. */
export const Line = Schema.Struct({
  /** The command that made it. An optimistic line and the event that confirms it share it. */
  commandId: Schema.String,
  kind: StatementLine.fields.kind,
  amount: Schema.Number,
  /** The balance after this line; known once it is confirmed. */
  balance: Schema.NullOr(Schema.Number),
  ack: Ack,
  /** Why the account refused it. */
  reason: Schema.NullOr(Schema.String),
});
export type Line = typeof Line.Type;

export const Model = Schema.Struct({
  customerId: CustomerId,
  accountId: AccountId,
  session: Schema.String,
  /** Commands this page has sent: with `session`, the next command's id. */
  sent: Schema.Number,
  /** `null` until the main account exists (register to open it). */
  balance: Schema.NullOr(Schema.Number),
  /** Unacknowledged lines first, then confirmed ones, newest first. */
  lines: Schema.Array(Line),
  error: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedRegister: {},
  ClickedDeposit: {},
  ClickedWithdraw: {},
  SucceededCommand: {},
  FailedCommand: { reason: Schema.String },
  /** The account accepted a command. Its line stays pending until its event arrives. */
  AcceptedCommand: { commandId: Schema.String },
  /** The account refused a command. */
  RejectedCommand: { commandId: Schema.String, reason: Schema.String },
  GotBalance: { balance: Schema.NullOr(Schema.Number) },
  /** A statement event, and the command that caused it. */
  GotLine: { commandId: Schema.String, line: StatementLine },
  FailedWatch: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMANDS: each runs one Fold command over the app's connection.

/** Register the signed-in customer; a policy then opens their main account. */
export const Register = Command.define("Register", {
  args: { customerId: CustomerId },
  messages: [Message.SucceededCommand, Message.FailedCommand],
  execute: ({ customerId }) =>
    Effect.gen(function* () {
      const bank = yield* CustomerApi.Client;
      yield* bank.RegisterCustomer({
        target: customerId,
        name: customerId,
        username: Username.make(customerId),
      });
      return Message.SucceededCommand();
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedCommand({ reason: error._tag })))),
});

/**
 * Resend a command whose connection failed. Safe because the account
 * deduplicates by `commandId`: a send that did land is not applied twice.
 */
const resendOnDisconnect = <A, E extends { readonly _tag: string }, R>(
  send: Effect.Effect<A, E, R>,
) =>
  send.pipe(
    Effect.retry({
      while: (error) => error._tag === "RpcClientError",
      schedule: Schedule.exponential("200 millis"),
      times: 5,
    }),
  );

export const Deposit = Command.define("Deposit", {
  args: { accountId: AccountId, amount: Schema.Number, commandId: Schema.String },
  messages: [Message.AcceptedCommand, Message.RejectedCommand],
  execute: ({ accountId, amount, commandId }) =>
    Effect.gen(function* () {
      const bank = yield* CustomerApi.Client;
      yield* resendOnDisconnect(bank.DepositMoney({ target: accountId, amount, commandId }));
      return Message.AcceptedCommand({ commandId });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.RejectedCommand({ commandId, reason: error._tag })),
      ),
    ),
});

export const Withdraw = Command.define("Withdraw", {
  args: { accountId: AccountId, amount: Schema.Number, commandId: Schema.String },
  messages: [Message.AcceptedCommand, Message.RejectedCommand],
  execute: ({ accountId, amount, commandId }) =>
    Effect.gen(function* () {
      const bank = yield* CustomerApi.Client;
      yield* resendOnDisconnect(bank.WithdrawMoney({ target: accountId, amount, commandId }, mfa));
      return Message.AcceptedCommand({ commandId });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.RejectedCommand({ commandId, reason: error._tag })),
      ),
    ),
});

// UPDATE

/** The next command's id. Unique across page loads, and stable if the command is resent. */
const nextCommandId = (model: Model) => `${model.session}:${model.sent}`;

/** Add a line the server has not acknowledged yet, above every other line. */
const optimistic = (
  model: Model,
  kind: Line["kind"],
  amount: number,
  commandId: string,
): Model => ({
  ...model,
  sent: model.sent + 1,
  error: null,
  lines: [{ commandId, kind, amount, balance: null, ack: "pending", reason: null }, ...model.lines],
});

/**
 * A statement event arrived. If this page sent its command, the pending line
 * becomes confirmed; otherwise (history, another tab) it is a new line. Either
 * way it goes above the confirmed lines and below the unacknowledged ones.
 */
const confirm = (model: Model, commandId: string, line: StatementLine): Model => {
  const confirmed: Line = {
    commandId,
    kind: line.kind,
    amount: line.amount,
    balance: line.balance,
    ack: "confirmed",
    reason: null,
  };
  const others = model.lines.filter((l) => l.commandId !== commandId);
  const unacknowledged = others.filter((l) => l.ack !== "confirmed");
  const acknowledged = others.filter((l) => l.ack === "confirmed");
  return { ...model, lines: [...unacknowledged, confirmed, ...acknowledged] };
};

const reject = (model: Model, commandId: string, reason: string): Model => ({
  ...model,
  lines: model.lines.map((l) =>
    l.commandId === commandId && l.ack === "pending" ? { ...l, ack: "rejected", reason } : l,
  ),
});

export const update = (model: Model, message: Message): Update.Return<Model, Message, Bank> =>
  Message.match<Update.Return<Model, Message, Bank>>(message, {
    ClickedRegister: () => ({ model, commands: [Register({ customerId: model.customerId })] }),
    ClickedDeposit: () => {
      const commandId = nextCommandId(model);
      return {
        model: optimistic(model, "deposit", 1_000, commandId),
        commands: [Deposit({ accountId: model.accountId, amount: 1_000, commandId })],
      };
    },
    ClickedWithdraw: () => {
      const commandId = nextCommandId(model);
      return {
        model: optimistic(model, "withdrawal", 1_000, commandId),
        commands: [Withdraw({ accountId: model.accountId, amount: 1_000, commandId })],
      };
    },
    SucceededCommand: () => ({ model: { ...model, error: null } }),
    FailedCommand: ({ reason }) => ({ model: { ...model, error: reason } }),
    // Accepted is not acknowledged: the line is confirmed by its event, which
    // may already have arrived.
    AcceptedCommand: () => ({ model }),
    RejectedCommand: ({ commandId, reason }) => ({ model: reject(model, commandId, reason) }),
    GotBalance: ({ balance }) => ({ model: { ...model, balance } }),
    GotLine: ({ commandId, line }) => ({ model: confirm(model, commandId, line) }),
    FailedWatch: ({ reason }) => ({ model: { ...model, error: `watch ended: ${reason}` } }),
  });

// INIT: the signed-in customer's main account.

export const init = (flags: Flags): Update.Return<Model, Message, Bank> => ({
  model: {
    customerId: flags.customerId,
    accountId: mainAccountId(flags.customerId),
    session: flags.session,
    sent: 0,
    balance: null,
    lines: [],
    error: null,
  },
});

// SUBSCRIPTIONS: the account's summary (snapshots) and statement (events), live.

export const subscriptions = Subscription.make<Model, Message, Bank>()((entry) => ({
  summary: entry(
    { accountId: AccountId },
    {
      modelToDependencies: (model) => ({ accountId: model.accountId }),
      dependenciesToStream: ({ accountId }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const bank = yield* CustomerApi.Client;
            return bank.AccountSummary.watch(accountId);
          }),
        ).pipe(
          Stream.map((summary) => Message.GotBalance({ balance: summary?.balance ?? null })),
          Stream.catch((error) => Stream.succeed(Message.FailedWatch({ reason: error._tag }))),
        ),
    },
  ),
  statement: entry(
    { accountId: AccountId },
    {
      modelToDependencies: (model) => ({ accountId: model.accountId }),
      dependenciesToStream: ({ accountId }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const bank = yield* CustomerApi.Client;
            return bank.Statement.events(accountId);
          }),
        ).pipe(
          Stream.map(({ event, envelope }) =>
            Message.GotLine({ commandId: envelope.commandId, line: event }),
          ),
          Stream.catch((error) => Stream.succeed(Message.FailedWatch({ reason: error._tag }))),
        ),
    },
  ),
}));

// VIEW

/** How a pending line moves the balance once it is confirmed. */
const signed = (line: Line) =>
  line.kind === "deposit" ||
  line.kind === "transfer-in" ||
  line.kind === "refund" ||
  line.kind === "settlement"
    ? line.amount
    : -line.amount;

/**
 * The balance to show: the newest confirmed balance (the statement's, so it
 * moves with the lines it confirms), plus every pending line.
 */
export const shownBalance = (model: Model): number | null => {
  if (model.balance === null) return null;
  const confirmed = model.lines.find((l) => l.ack === "confirmed")?.balance ?? model.balance;
  return model.lines
    .filter((l) => l.ack === "pending")
    .reduce((sum, l) => sum + signed(l), confirmed);
};

const button = "bg-black text-white hover:bg-gray-700 px-4 py-2";

const cents = (amount: number) => (amount / 100).toFixed(2);

const lineView = (line: Line, h: HtmlBuilder<Message>) => {
  const text = `${line.kind} ${cents(line.amount)}`;
  switch (line.ack) {
    case "pending":
      return h.li([h.Class("text-gray-400 italic")], [`${text}, pending`]);
    case "rejected":
      return h.li([h.Class("text-red-600 line-through")], [`${text}, rejected: ${line.reason}`]);
    case "confirmed":
      return h.li([], [`${text}, balance ${cents(line.balance ?? 0)}`]);
  }
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const balance = shownBalance(model);
  const pending = model.lines.some((l) => l.ack === "pending");
  return {
    title: balance === null ? "Bank" : `Balance: ${cents(balance)}`,
    body: h.div(
      [h.Class("flex flex-col gap-4 p-8")],
      [
        h.p([], [`Signed in as ${model.customerId}`]),
        ...(balance === null
          ? [h.button([h.OnClick(Message.ClickedRegister()), h.Class(button)], ["Open my account"])]
          : [
              h.div(
                [h.Class(pending ? "text-4xl font-bold text-gray-400" : "text-4xl font-bold")],
                [pending ? `${cents(balance)} (pending)` : cents(balance)],
              ),
              h.div(
                [h.Class("flex gap-2")],
                [
                  h.button(
                    [h.OnClick(Message.ClickedDeposit()), h.Class(button)],
                    ["Deposit 10.00"],
                  ),
                  h.button(
                    [h.OnClick(Message.ClickedWithdraw()), h.Class(button)],
                    ["Withdraw 10.00"],
                  ),
                ],
              ),
            ]),
        h.p([h.Class("text-red-600")], [model.error ?? ""]),
        h.ul(
          [],
          model.lines.map((line) => lineView(line, h)),
        ),
      ],
    ),
  };
};
