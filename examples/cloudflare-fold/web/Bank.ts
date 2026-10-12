import type { Api } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { AccountId, mainAccountId } from "../src/Account/AccountId.ts";
import { StatementLine } from "../src/Account/Statement.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import { CustomerApi } from "../src/CustomerApi/CustomerApi.ts";

/** The bank client this app runs on, provided by the `resources` Layer in `entry.ts`. */
type Bank = Api.ClientKey<"CustomerApi">;

/** The demo MFA code `MfaChallenge` accepts. */
const mfa = { headers: { "x-mfa-code": "000000" } };

// FLAGS: who is signed in, handed over when the app boots.

export const Flags = Schema.Struct({ customerId: CustomerId });
export type Flags = typeof Flags.Type;

// MODEL

export const Model = Schema.Struct({
  accountId: AccountId,
  balance: Schema.NullOr(Schema.Number),
  lines: Schema.Array(StatementLine),
  error: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedDeposit: {},
  ClickedWithdraw: {},
  SucceededCommand: { balance: Schema.Number },
  FailedCommand: { reason: Schema.String },
  GotBalance: { balance: Schema.NullOr(Schema.Number) },
  GotLine: { line: StatementLine },
  FailedWatch: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMANDS: each runs one Fold command over the app's connection.

export const Deposit = Command.define("Deposit", {
  args: { accountId: AccountId, amount: Schema.Number },
  messages: [Message.SucceededCommand, Message.FailedCommand],
  execute: ({ accountId, amount }) =>
    Effect.gen(function* () {
      const bank = yield* CustomerApi.Client;
      const { reply } = yield* bank.DepositMoney({ target: accountId, amount });
      return Message.SucceededCommand({ balance: reply.balance });
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedCommand({ reason: error._tag })))),
});

export const Withdraw = Command.define("Withdraw", {
  args: { accountId: AccountId, amount: Schema.Number },
  messages: [Message.SucceededCommand, Message.FailedCommand],
  execute: ({ accountId, amount }) =>
    Effect.gen(function* () {
      const bank = yield* CustomerApi.Client;
      const { reply } = yield* bank.WithdrawMoney({ target: accountId, amount }, mfa);
      return Message.SucceededCommand({ balance: reply.balance });
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedCommand({ reason: error._tag })))),
});

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message, Bank> =>
  Message.match<Update.Return<Model, Message, Bank>>(message, {
    ClickedDeposit: () => ({
      model,
      commands: [Deposit({ accountId: model.accountId, amount: 1_000 })],
    }),
    ClickedWithdraw: () => ({
      model,
      commands: [Withdraw({ accountId: model.accountId, amount: 1_000 })],
    }),
    // The balance arrives through the `summary` subscription; a reply only clears the error.
    SucceededCommand: () => ({ model: { ...model, error: null } }),
    FailedCommand: ({ reason }) => ({ model: { ...model, error: reason } }),
    GotBalance: ({ balance }) => ({ model: { ...model, balance } }),
    GotLine: ({ line }) => ({ model: { ...model, lines: [line, ...model.lines] } }),
    FailedWatch: ({ reason }) => ({ model: { ...model, error: `watch ended: ${reason}` } }),
  });

// INIT: the signed-in customer's main account.

export const init = (flags: Flags): Update.Return<Model, Message, Bank> => ({
  model: { accountId: mainAccountId(flags.customerId), balance: null, lines: [], error: null },
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
          Stream.map(({ event }) => Message.GotLine({ line: event })),
          Stream.catch((error) => Stream.succeed(Message.FailedWatch({ reason: error._tag }))),
        ),
    },
  ),
}));

// VIEW

const button = "bg-black text-white hover:bg-gray-700 px-4 py-2";

const cents = (amount: number) => (amount / 100).toFixed(2);

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.balance === null ? "Bank" : `Balance: ${cents(model.balance)}`,
  body: h.div(
    [h.Class("flex flex-col gap-4 p-8")],
    [
      h.div([h.Class("text-4xl font-bold")], [model.balance === null ? "…" : cents(model.balance)]),
      h.div(
        [h.Class("flex gap-2")],
        [
          h.button([h.OnClick(Message.ClickedDeposit()), h.Class(button)], ["Deposit 10.00"]),
          h.button([h.OnClick(Message.ClickedWithdraw()), h.Class(button)], ["Withdraw 10.00"]),
        ],
      ),
      h.p([h.Class("text-red-600")], [model.error ?? ""]),
      h.ul(
        [],
        model.lines.map((line) =>
          h.li([], [`${line.kind} ${cents(line.amount)}, balance ${cents(line.balance)}`]),
        ),
      ),
    ],
  ),
});
