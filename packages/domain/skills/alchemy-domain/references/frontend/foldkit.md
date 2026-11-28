# Foldkit

`@alchemy.run/domain/Foldkit` turns a Domain Api into Foldkit Commands and Subscriptions. It stays supported for apps written with Foldkit; start new apps on [Effect UI](effect-ui.md). Use it with Foldkit 0.169 or later. The snippets below use the bank example's `CustomerApi`.

More: [Integrate with Foldkit](https://alchemy.run/domain/foldkit).

## Derive the Commands

```ts
// packages/web/src/Bank.ts
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { CustomerApi } from "@bank/domain/CustomerApi.api";

export const Bank = DomainFoldkit.make(CustomerApi);
```

`Bank` has one Command per Api command and per Api query, and a `watch` and `events` reader for each View and Stream. `Bank.Message` is the Schema of every result.

More: [Integrate with Foldkit: Derive the Commands](https://alchemy.run/domain/foldkit#derive-the-commands).

## Send commands and follow a View

Allocate each command's id in `update` with `DomainFoldkit.next`, so a retry of `Unknown` sends the same id. Follow the View's state with `watch` and its feed with `events`:

```ts
// packages/web/src/Account.ts
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { AccountId } from "@bank/domain/Account/Account.id";
import { StatementLine } from "@bank/domain/Account/Statement.view";
import type { CustomerApi } from "@bank/domain/CustomerApi.api";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Bank } from "./Bank.ts";

type Client = typeof CustomerApi.Client.Identifier;

// A fresh `session` per page load names this page's commands.
export const Flags = Schema.Struct({ accountId: AccountId, session: Schema.String });
export type Flags = typeof Flags.Type;

export const Model = Schema.Struct({
  accountId: AccountId,
  commandIds: DomainFoldkit.CommandIds,
  balance: Schema.Option(Schema.Number),
  lines: Schema.Array(StatementLine),
  cursor: Schema.Option(Schema.Number),
  error: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  ClickedDeposit: {},
  ReceivedBankResult: { result: Bank.Message },
  ReceivedBalance: { balance: Schema.Option(Schema.Number) },
  ReceivedLine: { line: StatementLine, cursor: Schema.Number },
  CaughtUp: { cursor: Schema.Number },
  FailedRead: { reason: Schema.String },
});
export type Message = typeof Message.Type;

export const init = (flags: Flags): Update.Return<Model, Message, Client> => ({
  model: {
    accountId: flags.accountId,
    commandIds: { session: flags.session, sent: 0 },
    balance: Option.none(),
    lines: [],
    cursor: Option.none(),
    error: Option.none(),
  },
});

export const update = (model: Model, message: Message): Update.Return<Model, Message, Client> =>
  Message.match<Update.Return<Model, Message, Client>>(message, {
    // Allocate the id in update, so a retry of `Unknown` can send it again.
    ClickedDeposit: () => {
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      return {
        model: { ...model, commandIds },
        commands: [
          Command.mapMessage(
            Bank.DepositMoney({ input: { accountId: model.accountId, amount: 1_000 }, commandId }),
            (result) => Message.ReceivedBankResult({ result }),
          ),
        ],
      };
    },
    ReceivedBankResult: ({ result }) => ({
      model: {
        ...model,
        error:
          result._tag === "FailedDepositMoney" ? Option.some(result.failure._tag) : Option.none(),
      },
    }),
    ReceivedBalance: ({ balance }) => ({ model: { ...model, balance } }),
    ReceivedLine: ({ line, cursor }) => ({
      model: { ...model, lines: [...model.lines, line], cursor: Option.some(cursor) },
    }),
    CaughtUp: ({ cursor }) => ({ model: { ...model, cursor: Option.some(cursor) } }),
    FailedRead: ({ reason }) => ({ model: { ...model, error: Option.some(reason) } }),
  });

export const subscriptions = Subscription.make<Model, Message, Client>()(() => ({
  // The account's summary: each snapshot, as a Message.
  summary: Bank.AccountSummary.watch({
    key: (model: Model) => model.accountId,
    toMessage: ({ state }): Message =>
      Message.ReceivedBalance({ balance: Option.map(state, (summary) => summary.balance) }),
    onFailure: (error): Message => Message.FailedRead({ reason: error._tag }),
    onDefect: (): Message => Message.FailedRead({ reason: "Read defect" }),
  }),
  // The statement's lines after the last one applied.
  statement: Bank.Statement.events({
    key: (model: Model) => model.accountId,
    cursor: (model) => model.cursor,
    onEntry: ({ event, envelope }): Message =>
      Message.ReceivedLine({ line: event, cursor: envelope.seq }),
    onCaughtUp: (cursor): Message => Message.CaughtUp({ cursor }),
    onFailure: (error): Message => Message.FailedRead({ reason: error._tag }),
    onDefect: (): Message => Message.FailedRead({ reason: "Read defect" }),
  }),
}));

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Account",
  body: h.div(
    [],
    [
      h.p([], [Option.match(model.balance, { onNone: () => "No account", onSome: String })]),
      h.button([h.OnClick(Message.ClickedDeposit())], ["Deposit 10.00"]),
      h.ul([], model.lines.map((line) => h.li([], [`${line.kind} ${line.amount}`]))),
      h.p([], [Option.getOrElse(model.error, () => "")]),
    ],
  ),
});
```

A failure is `Rejected`, `Denied` or `Unknown`, and a Command defect is `Unknown` too. Retry `Unknown` with the original id, since the write may have committed. A key change restarts a read and a cursor change doesn't; interruption ends it without a Message. `toMessage` and `onCaughtUp` also receive the key, so a Model that keeps several keys files each snapshot under its own.

More: [Integrate with Foldkit: Send a command from update](https://alchemy.run/domain/foldkit#send-a-command-from-update), [Follow a View's state](https://alchemy.run/domain/foldkit#follow-a-views-state).

## Ask a query

A query has no live read, so it is a Command with `{ input, requestId, atLeast?, after?, take? }`. Keep the request in flight in the Model, and drop a reply with another id:

```ts
// packages/web/src/History.ts
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { AccountId } from "@bank/domain/Account/Account.id";
import type { CustomerApi } from "@bank/domain/CustomerApi.api";
import { LedgerRow } from "@bank/domain/Ledger/LedgerStore";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Bank } from "./Bank.ts";

type Client = typeof CustomerApi.Client.Identifier;

export const Flags = Schema.Struct({ accountId: AccountId, session: Schema.String });
export type Flags = typeof Flags.Type;

export const Model = Schema.Struct({
  accountId: AccountId,
  commandIds: DomainFoldkit.CommandIds,
  rows: Schema.Array(LedgerRow),
  /** The cursor of the next page; none on the last page. */
  next: Schema.Option(Schema.String),
  /** The page in flight. A reply with another id is stale. */
  requestId: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  ClickedMore: {},
  ReceivedBankResult: { result: Bank.Message },
});
export type Message = typeof Message.Type;

/** Ask for one page of 5, after `after`, with a fresh request id. */
const read = (model: Model, after: Option.Option<string>): Update.Return<Model, Message, Client> => {
  const { commandId: requestId, commandIds } = DomainFoldkit.next(model.commandIds);
  return {
    model: { ...model, commandIds, requestId: Option.some(requestId) },
    commands: [
      Command.mapMessage(
        Bank.AccountLedger({
          input: { account: model.accountId },
          requestId,
          take: 5,
          ...Option.match(after, { onNone: () => ({}), onSome: (cursor) => ({ after: cursor }) }),
        }),
        (result) => Message.ReceivedBankResult({ result }),
      ),
    ],
  };
};

export const init = (flags: Flags): Update.Return<Model, Message, Client> =>
  read(
    {
      accountId: flags.accountId,
      commandIds: { session: flags.session, sent: 0 },
      rows: [],
      next: Option.none(),
      requestId: Option.none(),
    },
    Option.none(),
  );

export const update = (model: Model, message: Message): Update.Return<Model, Message, Client> =>
  Message.match<Update.Return<Model, Message, Client>>(message, {
    ClickedMore: () =>
      Option.isSome(model.next) && Option.isNone(model.requestId)
        ? read(model, model.next)
        : { model },
    ReceivedBankResult: ({ result }) =>
      result._tag === "SucceededAccountLedger" &&
      Option.contains(model.requestId, result.requestId)
        ? {
            model: {
              ...model,
              rows: [...model.rows, ...result.result.entries],
              next: Option.fromNullishOr(result.result.cursor),
              requestId: Option.none(),
            },
          }
        : { model },
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "History",
  body: h.div(
    [],
    [
      h.ul([], model.rows.map((row) => h.li([], [`${row.kind} ${row.amount}`]))),
      ...(Option.isSome(model.next)
        ? [h.button([h.OnClick(Message.ClickedMore())], ["More"])]
        : []),
    ],
  ),
});
```

A paged result is `{ entries, cursor }`, and `cursor` is `null` on the last page. A failure is `Rejected`, `Denied`, `TimedOut` (only for a query with `waitsFor`) or `Unknown`; ask the last two again with a new id. Pass a command's `receipt` as `atLeast` to read your own write.

More: [Integrate with Foldkit: Ask a query](https://alchemy.run/domain/foldkit#ask-a-query), [Query](https://alchemy.run/domain/query).

## Start the app

Give the Api client to Foldkit as a resource, for the app's life. A fresh `session` per page load names the page's commands:

```ts
// packages/web/src/entry.ts
import * as Domain from "@alchemy.run/domain";
import { AccountId } from "@bank/domain/Account/Account.id";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { Flags, init, Model, subscriptions, update, view } from "./Account.ts";

// The Api client for the app's life, on this origin, so every call and live
// read carries the session cookie.
const BankConnection = CustomerApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
  Layer.provide(Layer.merge(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
);

Runtime.run(
  Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    resources: BankConnection,
    container: document.getElementById("root"),
  }),
  {
    flags: Effect.sync(() => ({
      accountId: AccountId.make("c-1-main"),
      // Names this page's commands, so each is unique even across reloads.
      session: crypto.randomUUID(),
    })),
  },
);
```

More: [Integrate with Foldkit: Provide the client and headers](https://alchemy.run/domain/foldkit#provide-the-client-and-headers).

## Test with stories

Foldkit stories drive `update` with no server: each Command stays pending until the story resolves it with the Message it would produce.

```ts
// packages/web/test/Account.test.ts
import { AccountId } from "@bank/domain/Account/Account.id";
import { expect, test } from "@effect/vitest";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { Bank } from "../src/Bank.ts";
import { init, Message, update } from "../src/Account.ts";

const account = init({ accountId: AccountId.make("c-1-main"), session: "page" }).model;

test("a refused deposit shows why", () =>
  story(
    update,
    given(account),
    message(Message.ClickedDeposit()),
    Command.resolve(
      Bank.DepositMoney,
      Bank.Message.FailedDepositMoney({ commandId: "page:0", failure: { _tag: "Unknown" } }),
    ),
    model((next) => {
      expect(next.commandIds.sent).toBe(1);
      expect(next.error).toEqual(Option.some("Unknown"));
    }),
  ));
```

`Cloudflare.Website.Foldkit` builds and deploys the app like `Cloudflare.Website.EffectUI`; see [index.md](index.md#serve-the-app-and-the-api-from-one-origin).

More: [Integrate with Foldkit: Test and host the app](https://alchemy.run/domain/foldkit#test-and-host-the-app).
