import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { AccountId, mainAccountId } from "@bank/domain/Account/Account.id";
import { StatementLine } from "@bank/domain/Account/Statement.view";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { Username } from "@bank/domain/Customer/Username";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { Command, Component, Head, UiSchema } from "@effect/ui";
import { Html, HtmlSubscription } from "@effect/ui/html";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/**
 * The CustomerApi as Effect UI Commands, queries and Subscriptions. History
 * reads the AccountLedger a page of 5 at a time, one entry per ledger row.
 */
export const BankUI = DomainEffectUI.make(CustomerApi, {
  queries: { AccountLedger: { take: 5, key: (row) => row.id } },
});

// MODEL

export const Intent = Schema.Struct({
  commandId: Schema.String,
  kind: Schema.Literals(["deposit", "withdrawal"]),
  amount: Schema.Number,
});
export type Intent = typeof Intent.Type;
export const intentsKey = (customerId: CustomerId) => `bank:intents:${customerId}`;

export const Ack = Schema.Literals(["Pending", "Queued", "Confirmed", "Rejected", "Denied"]);
export type Ack = typeof Ack.Type;
export const Line = Schema.Struct({
  commandId: Schema.String,
  kind: StatementLine.fields.kind,
  amount: Schema.Number,
  balance: Schema.Option(Schema.Number),
  ack: Ack,
  reason: Schema.Option(Schema.String),
});
export type Line = typeof Line.Type;

/**
 * What the page starts with. `session` names this page load's commands: an
 * intent keeps its id across reloads, so a retry never applies twice.
 */
export const BankProps = Schema.Struct({
  customerId: CustomerId,
  session: Schema.String,
  online: Schema.Boolean,
  intents: Schema.Array(Intent),
});
export type BankProps = typeof BankProps.Type;

export const Model = Schema.Struct({
  accountId: AccountId,
  /** How many intents this page has made, for the next id. */
  sent: Schema.Number,
  online: Schema.Boolean,
  balance: Schema.Option(Schema.Number),
  statementCursor: Schema.Option(Schema.Number),
  feedState: Schema.Literals(["CatchingUp", "Live", "Failed"]),
  lines: Schema.Array(Line),
  error: Schema.Option(Schema.String),
  showHistory: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Outcome = Schema.Struct({
  commandId: Schema.String,
  result: Schema.Literals(["Accepted", "Queued", "Rejected", "Denied"]),
  reason: Schema.Option(Schema.String),
});
export type Outcome = typeof Outcome.Type;

// MESSAGE

export const BankMessage = UiSchema.TaggedEnum({
  ClickedRegister: {},
  ClickedDeposit: {},
  ClickedWithdraw: {},
  ClickedRetryLine: { commandId: Schema.String },
  ClickedShowHistory: {},
  SucceededRegister: {},
  FailedRegister: { reason: Schema.String },
  CompletedDeliver: { outcomes: Schema.Array(Outcome) },
  ChangedConnectivity: { online: Schema.Boolean },
  ReceivedBalance: { balance: Schema.Option(Schema.Number) },
  ReceivedLine: { commandId: Schema.String, line: StatementLine, cursor: Schema.Number },
  CaughtUpStatement: { cursor: Schema.Number },
  FailedWatchSummary: { reason: Schema.String },
  FailedReadStatement: { reason: Schema.String },
});
export type BankMessage = typeof BankMessage.Type;

// COMMAND

/**
 * Send intents in order with their own ids. A refusal is final; a send that
 * can't reach the server is retried, then queued with everything after it.
 * Queued, so one delivery finishes before the next starts.
 */
export class Deliver extends Command.Service<Deliver>()("bank/Deliver", {
  args: { accountId: AccountId, intents: Schema.Array(Intent) },
  success: BankMessage,
  mode: "queue",
}) {}

export const DeliverLive = Deliver.toLayer(
  Effect.gen(function* () {
    // The adapter's own Commands: they classify a failure as Rejected,
    // Denied or Unknown, and keep the id a retry needs.
    const deposit = yield* BankUI.DepositMoney;
    const withdraw = yield* BankUI.WithdrawMoney;
    const send = (accountId: AccountId, { commandId, kind, amount }: Intent) =>
      (kind === "deposit" ? deposit : withdraw)({ input: { accountId, amount }, commandId }).pipe(
        Effect.as<Outcome>({ commandId, result: "Accepted", reason: Option.none() }),
        Effect.catchTags({
          Rejected: ({ rejection }) =>
            Effect.succeed<Outcome>({
              commandId,
              result: "Rejected",
              reason: Option.some(rejection._tag),
            }),
          Denied: ({ error }) =>
            Effect.succeed<Outcome>({
              commandId,
              result: "Denied",
              reason: Option.some(error._tag),
            }),
        }),
        // Unknown: the write may have committed, so retry with the same id.
        Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 3 }),
        Effect.catch(() =>
          Effect.succeed<Outcome>({ commandId, result: "Queued", reason: Option.none() }),
        ),
      );
    return Effect.fn(function* ({ accountId, intents }) {
      const outcomes: Array<Outcome> = [];
      for (const intent of intents) {
        const outcome = yield* send(accountId, intent);
        outcomes.push(outcome);
        if (outcome.result === "Queued") {
          for (const rest of intents.slice(outcomes.length)) {
            outcomes.push({ commandId: rest.commandId, result: "Queued", reason: Option.none() });
          }
          break;
        }
      }
      return BankMessage.CompletedDeliver({ outcomes });
    });
  }),
);

/** Keep the intents not yet acknowledged, so a reload sends them. */
export const SaveIntents = Command.make(
  "bank/SaveIntents",
  { args: { customerId: CustomerId, intents: Schema.Array(Intent) } },
  ({ customerId, intents }) =>
    Effect.sync(() => {
      localStorage.setItem(intentsKey(customerId), JSON.stringify(intents));
      return Component.noop;
    }),
);

// UPDATE

const isIntent = (line: Line): line is Line & { readonly kind: Intent["kind"] } =>
  (line.ack === "Pending" || line.ack === "Queued") &&
  (line.kind === "deposit" || line.kind === "withdrawal");
export const intentsOf = (model: Model): Array<Intent> =>
  model.lines
    .filter(isIntent)
    .map(({ commandId, kind, amount }) => ({ commandId, kind, amount }))
    .reverse();

const BankDef = Html.component({
  name: "Bank",
  props: BankProps,
  model: Model,
  message: BankMessage,
});

const save = (customerId: CustomerId, model: Model) =>
  SaveIntents.make({ customerId, intents: intentsOf(model) });

/**
 * Send what is queued, oldest first, when online: the lines it marks as
 * sending, and the intents to deliver.
 */
export const flush = (model: Model): { model: Model; intents: Array<Intent> } => {
  const queued = intentsOf(model).filter((intent) =>
    model.lines.some((line) => line.commandId === intent.commandId && line.ack === "Queued"),
  );
  if (!model.online || Array.isArrayEmpty(queued)) return { model, intents: [] };
  const sending = new Set(queued.map((intent) => intent.commandId));
  return {
    model: {
      ...model,
      lines: model.lines.map((line) =>
        sending.has(line.commandId) ? { ...line, ack: "Pending" } : line,
      ),
    },
    intents: queued,
  };
};

const deliverAll = (accountId: AccountId, intents: ReadonlyArray<Intent>) =>
  intents.length === 0 ? [] : [Deliver.make({ accountId, intents })];

/** Show the intent at once, keep it, and send it if nothing is queued ahead of it. */
const ask = (kind: Intent["kind"], amount: number) =>
  BankDef.update(($) => {
    const commandId = `${$.props.session}:${$.model.sent}`;
    const sending = $.model.online && !$.model.lines.some((line) => line.ack === "Queued");
    const line: Line = {
      commandId,
      kind,
      amount,
      balance: Option.none(),
      ack: sending ? "Pending" : "Queued",
      reason: Option.none(),
    };
    const next = {
      ...$.model,
      sent: $.model.sent + 1,
      error: Option.none(),
      lines: [line, ...$.model.lines],
    };
    return $.set(next).run(
      save($.props.customerId, next),
      ...(sending
        ? [Deliver.make({ accountId: $.model.accountId, intents: [{ commandId, kind, amount }] })]
        : []),
    );
  });

const delivered = (model: Model, outcomes: ReadonlyArray<Outcome>): Model => {
  const byId = new Map(outcomes.map((outcome) => [outcome.commandId, outcome]));
  return {
    ...model,
    lines: model.lines.map((line) => {
      const outcome = byId.get(line.commandId);
      if (!outcome || line.ack === "Confirmed") return line;
      return Match.value(outcome.result).pipe(
        Match.withReturnType<Line>(),
        Match.when("Accepted", () => line),
        Match.when("Queued", () => ({ ...line, ack: "Queued" })),
        Match.when("Denied", () => ({ ...line, ack: "Denied", reason: outcome.reason })),
        Match.when("Rejected", () => ({ ...line, ack: "Rejected", reason: outcome.reason })),
        Match.exhaustive,
      );
    }),
  };
};

/** The statement confirmed a line: it moves below the unacknowledged ones. */
const confirm = (model: Model, commandId: string, line: StatementLine, cursor: number): Model => {
  const confirmed: Line = {
    commandId,
    kind: line.kind,
    amount: line.amount,
    balance: Option.some(line.balance),
    ack: "Confirmed",
    reason: Option.none(),
  };
  const others = model.lines.filter((line) => line.commandId !== commandId);
  return {
    ...model,
    lines: [
      ...others.filter((line) => line.ack !== "Confirmed"),
      confirmed,
      ...others.filter((line) => line.ack === "Confirmed"),
    ],
    statementCursor: Option.some(cursor),
  };
};

// VIEW

const signed = (line: Line) =>
  line.kind === "deposit" ||
  line.kind === "transfer-in" ||
  line.kind === "refund" ||
  line.kind === "settlement"
    ? line.amount
    : -line.amount;

/** The confirmed balance, moved by every line still waiting for the bank. */
export const shownBalance = (model: Model): Option.Option<number> =>
  Option.map(model.balance, (balance) => {
    const confirmed = Option.flatMap(
      Array.findFirst(model.lines, (line) => line.ack === "Confirmed"),
      (line) => line.balance,
    );
    return model.lines
      .filter((line) => line.ack === "Pending" || line.ack === "Queued")
      .reduce(
        (sum, line) => sum + signed(line),
        Option.getOrElse(confirmed, () => balance),
      );
  });

const button = "bg-black text-white hover:bg-gray-700 px-4 py-2";
const cents = (amount: number) => (amount / 100).toFixed(2);

const lineView = BankDef.fragment((h, line: Line) => {
  const text = `${line.kind} ${cents(line.amount)}`;
  const item = h.li.key(line.commandId);
  return Match.value(line.ack).pipe(
    Match.when("Pending", () => item.class("text-gray-400 italic").children(`${text}, sending`)),
    Match.when("Queued", () =>
      item.class("text-amber-600 italic").children(`${text}, queued until online`),
    ),
    Match.when("Denied", () =>
      item.class("text-amber-600").children(
        `${text}, authentication required: ${Option.getOrElse(line.reason, () => "Denied")}`,
        h.button
          .class(button)
          .on("click", BankMessage.ClickedRetryLine({ commandId: line.commandId }))
          .children("Retry"),
      ),
    ),
    Match.when("Rejected", () =>
      item
        .class("text-red-600 line-through")
        .children(`${text}, rejected: ${Option.getOrElse(line.reason, () => "Rejected")}`),
    ),
    Match.when("Confirmed", () =>
      item.children(
        `${text}, balance ${Option.match(line.balance, { onNone: () => "unknown", onSome: cents })}`,
      ),
    ),
    Match.exhaustive,
  );
});

export const HistoryMessage = UiSchema.TaggedEnum({ ClickedMore: {} });

/** The account's ledger rows, a page at a time, read through the AccountLedger query. */
export const History = Html.component({
  name: "History",
  props: Schema.Struct({ accountId: AccountId }),
  model: Schema.Struct({}),
  message: HistoryMessage,
  queries: {
    ledger: {
      query: BankUI.AccountLedger,
      args: ({ props }) => ({ input: { account: props.accountId } }),
    },
  },
}).make({
  init: () => ({}),
  update: { ClickedMore: ($) => $.loadMore("ledger") },
  view: (h) =>
    AsyncResult.match(h.queries.ledger, {
      onInitial: () => h.p.class("text-gray-400 italic").children("Loading history"),
      onFailure: () => h.p.attr("role", "alert").children("History unavailable, try again"),
      onSuccess: ({ value: { items, more } }) =>
        h.div
          .class("flex flex-col gap-2")
          .children(
            h.ul
              .attr("aria-label", "History")
              .children(
                ...items.map((row) =>
                  h.li
                    .key(row.id)
                    .children(
                      `${row.kind} ${cents(row.amount)}, balance ${cents(row.balanceAfter)}`,
                    ),
                ),
              ),
            more._tag === "Loading" &&
              h.p.class("text-gray-400 italic").children("Loading history"),
            more._tag === "Available" &&
              h.button.class(button).on("click", HistoryMessage.ClickedMore()).children("More"),
          ),
    }),
});

/**
 * The bank, local first: deposits and withdrawals show at once, wait in
 * `localStorage` while offline, and are sent in order with their ids. The
 * statement feed confirms each one.
 */
export const BankNoDeps = BankDef.make({
  init: ($) => {
    const model: Model = {
      accountId: mainAccountId($.props.customerId),
      sent: 0,
      online: $.props.online,
      balance: Option.none(),
      statementCursor: Option.none(),
      feedState: "CatchingUp",
      lines: $.props.intents
        .map((intent): Line => ({
          ...intent,
          balance: Option.none(),
          ack: "Queued",
          reason: Option.none(),
        }))
        .reverse(),
      error: Option.none(),
      showHistory: false,
    };
    // Intents an earlier page load could not deliver go first.
    const flushed = flush(model);
    return $.set(flushed.model).run(...deliverAll(model.accountId, flushed.intents));
  },
  update: {
    ClickedRegister: ($) =>
      $.run(
        BankUI.RegisterCustomer.make({
          input: {
            customerId: $.props.customerId,
            name: $.props.customerId,
            username: Username.make($.props.customerId),
          },
        }).pipe(
          Command.match({
            onSuccess: () => BankMessage.SucceededRegister(),
            onFailure: (failure) => BankMessage.FailedRegister({ reason: failure._tag }),
          }),
        ),
      ),
    // The account appears through the summary watch.
    SucceededRegister: ($) => $.evolve({ error: Option.none() }),
    FailedRegister: ($, { reason }) => $.evolve({ error: Option.some(reason) }),
    ClickedShowHistory: ($) => $.evolve({ showHistory: true }),
    ClickedDeposit: ask("deposit", 1_000),
    ClickedWithdraw: ask("withdrawal", 1_000),
    ClickedRetryLine: ($, { commandId }) => {
      const flushed = flush({
        ...$.model,
        lines: $.model.lines.map((line) =>
          line.commandId === commandId && line.ack === "Denied"
            ? { ...line, ack: "Queued", reason: Option.none() }
            : line,
        ),
      });
      return $.set(flushed.model).run(
        save($.props.customerId, flushed.model),
        ...deliverAll(flushed.model.accountId, flushed.intents),
      );
    },
    CompletedDeliver: ($, { outcomes }) => {
      const next = delivered($.model, outcomes);
      return $.set(next).run(save($.props.customerId, next));
    },
    ChangedConnectivity: ($, { online }) => {
      if (!online) return $.evolve({ online: false, feedState: "CatchingUp" });
      const flushed = flush({ ...$.model, online: true });
      return $.set(flushed.model).run(...deliverAll(flushed.model.accountId, flushed.intents));
    },
    ReceivedBalance: ($, { balance }) => $.evolve({ balance }),
    ReceivedLine: ($, { commandId, line, cursor }) => {
      const next = confirm($.model, commandId, line, cursor);
      return $.set(next).run(save($.props.customerId, next));
    },
    CaughtUpStatement: ($, { cursor }) =>
      $.evolve({ statementCursor: Option.some(cursor), feedState: "Live" }),
    FailedWatchSummary: ($, { reason }) => $.evolve({ error: Option.some(reason) }),
    FailedReadStatement: ($, { reason }) =>
      $.evolve({ error: Option.some(reason), feedState: "Failed" }),
  },
  // While online, follow the balance and the statement. The statement feed
  // starts after the last line this page applied, so a reconnect resumes it.
  subscriptions: ({ model }) => [
    HtmlSubscription.onConnectivity((online) => BankMessage.ChangedConnectivity({ online })),
    model.online &&
      BankUI.AccountSummary.watch<BankMessage>(model.accountId, {
        onSnapshot: ({ state }) =>
          BankMessage.ReceivedBalance({ balance: Option.map(state, (summary) => summary.balance) }),
        onFailure: (error) => BankMessage.FailedWatchSummary({ reason: error._tag }),
        onDefect: () => BankMessage.FailedWatchSummary({ reason: "Read defect" }),
      }),
    model.online &&
      BankUI.Statement.events<BankMessage>(model.accountId, {
        after: model.statementCursor,
        onEntry: ({ event, envelope }) =>
          BankMessage.ReceivedLine({
            commandId: envelope.commandId,
            line: event,
            cursor: envelope.seq,
          }),
        onCaughtUp: (cursor) => BankMessage.CaughtUpStatement({ cursor }),
        onFailure: (error) => BankMessage.FailedReadStatement({ reason: error._tag }),
        onDefect: () => BankMessage.FailedReadStatement({ reason: "Read defect" }),
      }),
  ],
  head: ({ model }) => [
    Head.title(
      Option.match(shownBalance(model), {
        onNone: () => "Bank",
        onSome: (amount) => `Balance: ${cents(amount)}`,
      }),
    ),
  ],
  view: (h, model) => {
    const balance = shownBalance(model);
    const isUnacknowledged = model.lines.some(
      (line) => line.ack === "Pending" || line.ack === "Queued",
    );
    return h.div.class("flex flex-col gap-4 p-8").children(
      h.p(`Signed in as ${h.props.customerId}`),
      !model.online &&
        h.p
          .class("text-amber-600")
          .children("Offline: changes are kept and sent when you reconnect."),
      ...Option.match(balance, {
        onNone: () => [
          h.button
            .class(button)
            .on("click", BankMessage.ClickedRegister())
            .children("Open my account"),
        ],
        onSome: (amount) => [
          h.div
            .attr("aria-label", "Balance")
            .class("text-4xl font-bold", isUnacknowledged && "text-gray-400")
            .children(isUnacknowledged ? `${cents(amount)} (pending)` : cents(amount)),
          h.div
            .class("flex gap-2")
            .children(
              h.button
                .class(button)
                .on("click", BankMessage.ClickedDeposit())
                .children("Deposit 10.00"),
              h.button
                .class(button)
                .on("click", BankMessage.ClickedWithdraw())
                .children("Withdraw 10.00"),
            ),
        ],
      }),
      h.p(model.feedState === "Live" ? "Statement is live" : "Statement is catching up"),
      Option.isSome(model.error) &&
        h.p.attr("role", "alert").class("text-red-600").children(model.error.value),
      h.ul
        .attr("aria-label", "Statement")
        .children(...model.lines.map((line) => lineView(h, line))),
      model.showHistory
        ? History(h, { key: "history", props: { accountId: model.accountId } })
        : h.button.class(button).on("click", BankMessage.ClickedShowHistory()).children("History"),
    );
  },
});

/** The bank with its Commands and queries; the entry provides the CustomerApi client. */
export const Bank = BankNoDeps.pipe(
  Component.provide(DeliverLive.pipe(Layer.provideMerge(BankUI.layer))),
);
