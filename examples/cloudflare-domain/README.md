# cloudflare-domain

A bank built with `alchemy/Domain`: aggregates, views, policies and ports declared as pure, typed definitions, exposed through two Apis, hosted on Cloudflare Durable Objects, and driven from a foldkit app.

An Api exposes commands (writes) and views and aggregates (reads). Each one is a security boundary: its middleware authenticates the caller, and its `decide` or `validate` decides what that caller may do or see.

## Commands

A command lives in its own file with the events it records and the rejections only it returns. Its middleware authenticates the caller and provides who is acting:

```ts
// src/Customer/RegisterCustomer.ts
import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";
import { Session } from "../Session.ts";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

/** The customer is registered, or a registration is already in progress. */
export class AlreadyRegistered extends Domain.Rejection("AlreadyRegistered") {}

/** A customer may only register themselves. */
export class NotTheCustomer extends Domain.Rejection("NotTheCustomer") {}

/** Registration waits for `UsernameReservation` to claim the username. */
export class RegistrationRequested extends Domain.Event("RegistrationRequested", {
  data: { name: Schema.String, username: Username },
}) {}

/**
 * Sign up as a customer under a unique username. The customer is registered
 * once the username is claimed; `MainAccountProvisioning` then opens their
 * main account.
 */
export class RegisterCustomer extends Domain.Command("RegisterCustomer", {
  target: CustomerId,
  middleware: [Session],
  input: { name: Schema.String, username: Username },
  events: [RegistrationRequested],
  rejects: [AlreadyRegistered, NotTheCustomer],
}) {}
```

`Session` provides `CurrentActor`, a customer or a support agent, from the request's token:

```ts
// src/Session.ts
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { type Actor, agent, customer } from "./Actor.ts";
import { CurrentActor } from "./CurrentActor.ts";
import { CustomerId } from "./Customer/CustomerId.ts";
import { Unauthorized } from "./Unauthorized.ts";

/** The cookie that carries a customer's session in a browser. */
export const SESSION_COOKIE = "bank_session";

/**
 * Authenticates a request, from a customer or a support agent, and provides
 * who is making it as the {@link CurrentActor}. Authorization is up to each
 * command's `decide` and each view's `validate`.
 *
 * Browsers authenticate with the session cookie, which also reaches live
 * reads: a WebSocket upgrade carries cookies, never a header a client sets.
 * Other clients (tests, support tooling) send `Authorization` instead.
 */
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()(
  "Bank/Session",
  { error: Unauthorized },
) {}

const parse = (token: string): Option.Option<Actor> => {
  const match = /^(customer|agent):(.+)$/.exec(token);
  if (!match) return Option.none();
  return Option.some(match[1] === "customer" ? customer(match[2]!) : agent(match[2]!));
};

const fromCookie = (headers: Headers.Headers): Option.Option<Actor> =>
  Option.flatMap(Headers.get(headers, "cookie"), (cookie) =>
    Option.flatMap(Option.fromNullishOr(Cookies.parseHeader(cookie)[SESSION_COOKIE]), (token) =>
      Option.filter(parse(token), (actor) => actor._tag === "Customer"),
    ),
  );

const fromAuthorization = (headers: Headers.Headers): Option.Option<Actor> =>
  Option.flatMap(Headers.get(headers, "authorization"), (value) =>
    value.startsWith("Bearer ") ? parse(value.slice("Bearer ".length)) : Option.none(),
  );

/**
 * Demo verifier: the session cookie (`customer:<id>`, from {@link sessionRoute}),
 * or `Authorization: Bearer customer:<id>` / `Bearer agent:<id>`. In
 * production, sign the cookie (or keep sessions server-side) and verify a
 * Cloudflare Access JWT for agents.
 */
export const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(
    Option.orElse(fromCookie(headers), () => fromAuthorization(headers)),
    {
      onNone: () => Effect.fail(new Unauthorized()),
      onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
    },
  ),
);

const SignIn = Schema.Struct({ customerId: CustomerId });

/**
 * `POST /api/session` signs a customer in by setting the session cookie;
 * `DELETE` signs them out. `HttpOnly` keeps it from scripts, and
 * `SameSite=Strict` keeps it off cross-site requests, WebSocket upgrades
 * included. Demo only: anyone may sign in as anyone.
 */
export const sessionRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const options = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;
  if (request.method === "DELETE") {
    return HttpServerResponse.empty({ status: 204 }).pipe(
      HttpServerResponse.setCookieUnsafe(SESSION_COOKIE, "", { ...options, maxAge: 0 }),
    );
  }
  if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
  const body = yield* request.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SignIn)),
    Effect.option,
  );
  if (Option.isNone(body))
    return HttpServerResponse.text("Expected { customerId }", { status: 400 });
  return HttpServerResponse.empty({ status: 204 }).pipe(
    HttpServerResponse.setCookieUnsafe(
      SESSION_COOKIE,
      `customer:${body.value.customerId}`,
      options,
    ),
  );
});

/** Client side, for clients that are not browsers: send this token with every call. */
export const sessionClient = (token: string) =>
  RpcMiddleware.layerClient(Session, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }),
  );
```

The aggregate implements the command. `decide` reads what the command's middleware provides and authorizes against the current state:

```ts
// src/Customer/Customer.ts
import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentActor } from "../CurrentActor.ts";
import { ConfirmRegistration, CustomerRegistered } from "./ConfirmRegistration.ts";
import { CustomerId } from "./CustomerId.ts";
import {
  AlreadyRegistered,
  NotTheCustomer,
  RegisterCustomer,
  RegistrationRequested,
} from "./RegisterCustomer.ts";
import { RegistrationRejected, RejectRegistration } from "./RejectRegistration.ts";
import { Username } from "./Username.ts";

const Profile = { name: Schema.String, username: Username };

/**
 * A customer. Registration is a small saga: the request records the profile,
 * `UsernameReservation` claims the username, then the registration is
 * confirmed or rejected.
 */
export class Customer extends Domain.Aggregate("Customer", {
  id: CustomerId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Pending", Profile),
    Schema.TaggedStruct("Registered", Profile),
  ]),
  initial: { _tag: "New" },
  commands: [RegisterCustomer, ConfirmRegistration, RejectRegistration],
  decide: {
    RegisterCustomer: Effect.fn(function* (s, cmd, { id }) {
      const actor = yield* CurrentActor;
      if (actor._tag === "Customer" && actor.customerId !== id) return yield* new NotTheCustomer();
      if (s._tag !== "New") return yield* new AlreadyRegistered();
      return [new RegistrationRequested({ name: cmd.name, username: cmd.username })];
    }),
    ConfirmRegistration: (s) =>
      s._tag === "Pending" ? [new CustomerRegistered({ name: s.name, username: s.username })] : [],
    RejectRegistration: (s, cmd) =>
      s._tag === "Pending"
        ? [new RegistrationRejected({ username: s.username, reason: cmd.reason })]
        : [],
  },
  evolve: {
    RegistrationRequested: (_, e) => ({
      _tag: "Pending" as const,
      name: e.name,
      username: e.username,
    }),
    CustomerRegistered: (_, e) => ({
      _tag: "Registered" as const,
      name: e.name,
      username: e.username,
    }),
    RegistrationRejected: () => ({ _tag: "New" as const }),
  },
}) {}
```

## Views

A view folds events into state per key, and is a security boundary like a command. `validate` judges every read from who is asking, the key and that key's state; it runs on every `get` and `list`, and on every change while a client watches. Filters a client sends only narrow what a permitted read returns. To show an audience different data, make another view.

```ts
// src/Account/AccountSummary.ts
import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CustomerId } from "../Customer/CustomerId.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.ts";
import { Account } from "./Account.ts";
import { mustOwn } from "./mustOwn.ts";
import { NotOwner } from "./NotOwner.ts";

const setBalance = <V extends { balance: number }>(
  v: V,
  e: { readonly balanceAfter: number },
): V => ({
  ...v,
  balance: e.balanceAfter,
});

/**
 * The current balance and status of one account. It declares no events, so
 * it emits every event it applies, each with the summary after it.
 */
export class AccountSummary extends Domain.View("AccountSummary", {
  from: [Account],
  key: Account,
  middleware: [Session],
  rejects: [NotOwner],
  state: Schema.Struct({
    customerId: Schema.NullOr(CustomerId),
    owner: Schema.NullOr(Schema.String),
    balance: Cents,
    frozen: Schema.Boolean,
    closed: Schema.Boolean,
  }),
  initial: { customerId: null, owner: null, balance: 0, frozen: false, closed: false },
  evolve: {
    AccountOpened: (v, e) => ({ ...v, customerId: e.customerId, owner: e.owner }),
    OwnerChanged: (v, e) => ({ ...v, customerId: e.customerId }),
    MoneyDeposited: setBalance,
    MoneyWithdrawn: setBalance,
    TransferDebited: setBalance,
    TransferCredited: setBalance,
    TransferRefunded: setBalance,
    SettlementReceived: setBalance,
    AccountFrozen: (v) => ({ ...v, frozen: true }),
    AccountClosed: (v) => ({ ...v, closed: true }),
  },
  // Re-run on every change while watched: a reassigned account ends the watch with NotOwner.
  validate: Effect.fn(function* (_request, summary) {
    yield* mustOwn(summary?.customerId ?? null);
  }),
}) {}
```

The rule is shared with the `Account` aggregate's `read` contract and the other account views:

```ts
// src/Account/mustOwn.ts
import * as Effect from "effect/Effect";
import { CurrentActor } from "../CurrentActor.ts";
import type { CustomerId } from "../Customer/CustomerId.ts";
import { NotOwner } from "./NotOwner.ts";

/**
 * Who may read an account's data: any agent, or the customer who owns the
 * account right now. An account that doesn't exist yet reads as empty, so a
 * client can watch for it to appear; someone else's is rejected.
 */
export const mustOwn = Effect.fn(function* (owner: CustomerId | null) {
  const actor = yield* CurrentActor;
  if (actor._tag === "Agent" || owner === null) return;
  if (actor._tag !== "Customer" || owner !== actor.customerId) return yield* new NotOwner();
});
```

## The Api

Nothing in an Api needs a handler: aggregates implement commands and the Domain hosts views.

```ts
// src/CustomerApi/CustomerApi.ts
import * as Domain from "alchemy/Domain";
import { Account } from "../Account/Account.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { CloseAccount } from "../Account/CloseAccount.ts";
import { DepositMoney } from "../Account/DepositMoney.ts";
import { Statement } from "../Account/Statement.ts";
import { WithdrawMoney } from "../Account/WithdrawMoney.ts";
import { CustomerDashboard } from "../Customer/CustomerDashboard.ts";
import { RegisterCustomer } from "../Customer/RegisterCustomer.ts";
import { AccountTransfers } from "../Transfer/AccountTransfers.ts";
import { RequestTransfer } from "../Transfer/RequestTransfer.ts";
import { TransferStatus } from "../Transfer/TransferStatus.ts";

/**
 * What the customer app reaches: commands to change things, and the Account
 * aggregate and views to read and watch. Each entry authorizes itself,
 * through its `decide` or `validate`.
 */
export class CustomerApi extends Domain.Api(
  "CustomerApi",
  RegisterCustomer,
  DepositMoney,
  WithdrawMoney,
  CloseAccount,
  RequestTransfer,
  Account,
  CustomerDashboard,
  AccountSummary,
  Statement,
  AccountTransfers,
  TransferStatus,
) {}
```

A client gets commands as methods and views and aggregates as namespaces: `bank.DepositMoney({ target, amount })`, `bank.AccountSummary.watch(accountId)`, `bank.Statement.list(accountId, { order: "desc" })`, `bank.Account.events(accountId)`.

Watches are pushed. Over `Api.protocolWebSocket`, every `watch` and `events` call opens its own WebSocket. The Worker runs the read's middleware, then hands the socket to the Durable Object that owns the key. Each commit pushes the change down the socket after `validate` judges it again, and the object hibernates in between. Commands, `get` and `list` stay on HTTP.

## A foldkit app

The app's Commands run Fold commands, and its Subscriptions watch a view's snapshots and another's events. The client is a foldkit resource, provided once in [`src/web/entry.ts`](src/web/entry.ts).

```ts
// src/web/Bank.ts
import type * as Domain from "alchemy/Domain";
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
type Bank = Domain.Api.ClientKey<"CustomerApi">;

/** The demo MFA code `MfaChallenge` accepts. */
const mfa = { headers: { "x-mfa-code": "000000" } };

// INTENTS: what the customer asked for that the server has not acknowledged.
// They are kept across reloads, so asking works offline.

/** A deposit or withdrawal the customer asked for, named by the command that carries it. */
export const Intent = Schema.Struct({
  commandId: Schema.String,
  kind: Schema.Literals(["deposit", "withdrawal"]),
  amount: Schema.Number,
});
export type Intent = typeof Intent.Type;

/** Where a customer's unacknowledged intents are kept between page loads. */
export const intentsKey = (customerId: CustomerId) => `bank:intents:${customerId}`;

// FLAGS: who is signed in, and what this browser still owes the server.

export const Flags = Schema.Struct({
  customerId: CustomerId,
  /** Unique per page load; with a counter, it names every command this page sends. */
  session: Schema.String,
  online: Schema.Boolean,
  /** Intents saved by an earlier page load, oldest first. */
  intents: Schema.Array(Intent),
});
export type Flags = typeof Flags.Type;

// MODEL

/**
 * Whether the server has acknowledged a line:
 * - `pending`: sent, waiting for the event it causes on the statement stream;
 * - `queued`: not sent, because the server could not be reached; sent when back online;
 * - `confirmed`: its event arrived;
 * - `rejected`: the account refused the command.
 */
export const Ack = Schema.Literals(["pending", "queued", "confirmed", "rejected"]);
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
  online: Schema.Boolean,
  /** `null` until the main account exists (register to open it). */
  balance: Schema.NullOr(Schema.Number),
  /** Unacknowledged lines first, then confirmed ones, newest first. */
  lines: Schema.Array(Line),
  error: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

/** What delivering one intent came to. */
export const Outcome = Schema.Struct({
  commandId: Schema.String,
  /** `accepted` waits for its event; `queued` waits for the network. */
  result: Schema.Literals(["accepted", "queued", "rejected"]),
  reason: Schema.NullOr(Schema.String),
});
export type Outcome = typeof Outcome.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedRegister: {},
  ClickedDeposit: {},
  ClickedWithdraw: {},
  SucceededCommand: {},
  FailedCommand: { reason: Schema.String },
  /** Intents were delivered in order, up to the first that could not reach the server. */
  Delivered: { outcomes: Schema.Array(Outcome) },
  SavedIntents: {},
  WentOnline: {},
  WentOffline: {},
  GotBalance: { balance: Schema.NullOr(Schema.Number) },
  /** A statement event, and the command that caused it. */
  GotLine: { commandId: Schema.String, line: StatementLine },
  FailedWatch: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMANDS: each runs domain commands over the app's connection.

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
 * Send one intent. A dropped connection is retried briefly, which is safe
 * because the account deduplicates by `commandId`: a send that did land is
 * not applied twice. If the server still cannot be reached, the intent is
 * queued; a rejection is the account's answer.
 */
const deliver = (accountId: AccountId, intent: Intent) =>
  Effect.gen(function* () {
    const bank = yield* CustomerApi.Client;
    const { commandId, amount } = intent;
    const send =
      intent.kind === "deposit"
        ? bank.DepositMoney({ target: accountId, amount, commandId })
        : bank.WithdrawMoney({ target: accountId, amount, commandId }, mfa);
    return yield* send.pipe(
      Effect.retry({
        while: (error) => error._tag === "RpcClientError",
        schedule: Schedule.exponential("200 millis"),
        times: 3,
      }),
      Effect.as<Outcome>({ commandId, result: "accepted", reason: null }),
      Effect.catch((error) =>
        Effect.succeed<Outcome>(
          error._tag === "RpcClientError"
            ? { commandId, result: "queued", reason: null }
            : { commandId, result: "rejected", reason: error._tag },
        ),
      ),
    );
  });

/**
 * Deliver intents in the order they were made, stopping at the first that
 * cannot reach the server: the rest stay queued, so a withdrawal never
 * overtakes the deposit it was made after.
 */
export const Deliver = Command.define("Deliver", {
  args: { accountId: AccountId, intents: Schema.Array(Intent) },
  messages: [Message.Delivered],
  execute: ({ accountId, intents }) =>
    Effect.gen(function* () {
      const outcomes: Array<Outcome> = [];
      for (const intent of intents) {
        const outcome = yield* deliver(accountId, intent);
        outcomes.push(outcome);
        if (outcome.result === "queued") {
          for (const rest of intents.slice(outcomes.length)) {
            outcomes.push({ commandId: rest.commandId, result: "queued", reason: null });
          }
          break;
        }
      }
      return Message.Delivered({ outcomes });
    }),
});

/** Keep the unacknowledged intents for the next page load. */
export const SaveIntents = Command.define("SaveIntents", {
  args: { customerId: CustomerId, intents: Schema.Array(Intent) },
  messages: [Message.SavedIntents],
  execute: ({ customerId, intents }) =>
    Effect.sync(() => {
      localStorage.setItem(intentsKey(customerId), JSON.stringify(intents));
      return Message.SavedIntents();
    }),
});

// UPDATE

/** The next command's id. Unique across page loads, and stable if the command is resent. */
const nextCommandId = (model: Model) => `${model.session}:${model.sent}`;

const isIntent = (line: Line): line is Line & { readonly kind: Intent["kind"] } =>
  (line.ack === "pending" || line.ack === "queued") &&
  (line.kind === "deposit" || line.kind === "withdrawal");

/** The model's unacknowledged intents, oldest first. */
const intentsOf = (model: Model): Array<Intent> =>
  model.lines
    .filter(isIntent)
    .map(({ commandId, kind, amount }) => ({ commandId, kind, amount }))
    .reverse();

const save = (model: Model) =>
  SaveIntents({ customerId: model.customerId, intents: intentsOf(model) });

/**
 * Add a line the server has not acknowledged, above every other line. Sent
 * now if the server is reachable and nothing older is waiting; otherwise
 * queued behind what is.
 */
const ask = (
  model: Model,
  kind: Intent["kind"],
  amount: number,
): Update.Return<Model, Message, Bank> => {
  const commandId = nextCommandId(model);
  const send = model.online && !model.lines.some((l) => l.ack === "queued");
  const next: Model = {
    ...model,
    sent: model.sent + 1,
    error: null,
    lines: [
      { commandId, kind, amount, balance: null, ack: send ? "pending" : "queued", reason: null },
      ...model.lines,
    ],
  };
  return {
    model: next,
    commands: [
      save(next),
      ...(send
        ? [Deliver({ accountId: model.accountId, intents: [{ commandId, kind, amount }] })]
        : []),
    ],
  };
};

/** Send every queued intent, oldest first. */
const flush = (model: Model): Update.Return<Model, Message, Bank> => {
  const queued = intentsOf(model).filter((intent) =>
    model.lines.some((l) => l.commandId === intent.commandId && l.ack === "queued"),
  );
  if (queued.length === 0) return { model };
  const sending = new Set(queued.map((intent) => intent.commandId));
  return {
    model: {
      ...model,
      lines: model.lines.map((l) => (sending.has(l.commandId) ? { ...l, ack: "pending" } : l)),
    },
    commands: [Deliver({ accountId: model.accountId, intents: queued })],
  };
};

/**
 * Apply what delivery came to. A confirmed line stays confirmed: its event
 * can arrive before the reply.
 */
const delivered = (model: Model, outcomes: ReadonlyArray<Outcome>): Model => {
  const byId = new Map(outcomes.map((o) => [o.commandId, o]));
  return {
    ...model,
    lines: model.lines.map((l): Line => {
      const outcome = byId.get(l.commandId);
      if (!outcome || l.ack === "confirmed") return l;
      switch (outcome.result) {
        case "accepted":
          return l;
        case "queued":
          return { ...l, ack: "queued" };
        case "rejected":
          return { ...l, ack: "rejected", reason: outcome.reason };
      }
    }),
  };
};

/**
 * A statement event arrived. If this browser asked for it, its line becomes
 * confirmed; otherwise (history, a transfer, another device) it is a new
 * line. Either way it goes above the confirmed lines and below the
 * unacknowledged ones.
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

export const update = (model: Model, message: Message): Update.Return<Model, Message, Bank> =>
  Message.match<Update.Return<Model, Message, Bank>>(message, {
    ClickedRegister: () => ({ model, commands: [Register({ customerId: model.customerId })] }),
    ClickedDeposit: () => ask(model, "deposit", 1_000),
    ClickedWithdraw: () => ask(model, "withdrawal", 1_000),
    SucceededCommand: () => ({ model: { ...model, error: null } }),
    FailedCommand: ({ reason }) => ({ model: { ...model, error: reason } }),
    Delivered: ({ outcomes }) => {
      const next = delivered(model, outcomes);
      return { model: next, commands: [save(next)] };
    },
    SavedIntents: () => ({ model }),
    WentOnline: () => flush({ ...model, online: true }),
    WentOffline: () => ({ model: { ...model, online: false } }),
    GotBalance: ({ balance }) => ({ model: { ...model, balance } }),
    GotLine: ({ commandId, line }) => {
      const next = confirm(model, commandId, line);
      return { model: next, commands: [save(next)] };
    },
    FailedWatch: ({ reason }) => ({ model: { ...model, error: `watch ended: ${reason}` } }),
  });

// INIT: the signed-in customer's main account, and what an earlier page load still owes.

export const init = (flags: Flags): Update.Return<Model, Message, Bank> => {
  const model: Model = {
    customerId: flags.customerId,
    accountId: mainAccountId(flags.customerId),
    session: flags.session,
    sent: 0,
    online: flags.online,
    balance: null,
    // Restored intents are queued: the statement's history confirms those the
    // server already applied, and the rest are sent when online.
    lines: flags.intents
      .map((intent): Line => ({ ...intent, balance: null, ack: "queued", reason: null }))
      .reverse(),
    error: null,
  };
  return model.online ? flush(model) : { model };
};

// SUBSCRIPTIONS: connectivity, and the account's summary (snapshots) and
// statement (events), live while online.

export const subscriptions = Subscription.make<Model, Message, Bank>()((entry) => ({
  connectivity: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.merge(
          Stream.fromEventListener(window, "online").pipe(Stream.as(Message.WentOnline())),
          Stream.fromEventListener(window, "offline").pipe(Stream.as(Message.WentOffline())),
        ),
    },
  ),
  // Depending on `online` restarts a watch when the browser comes back,
  // however long it was gone.
  summary: entry(
    { accountId: AccountId, online: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ accountId: model.accountId, online: model.online }),
      dependenciesToStream: ({ accountId, online }) =>
        online
          ? Stream.unwrap(
              Effect.gen(function* () {
                const bank = yield* CustomerApi.Client;
                return bank.AccountSummary.watch(accountId);
              }),
            ).pipe(
              Stream.map((summary) => Message.GotBalance({ balance: summary?.balance ?? null })),
              Stream.catch((error) => Stream.succeed(Message.FailedWatch({ reason: error._tag }))),
            )
          : Stream.empty,
    },
  ),
  statement: entry(
    { accountId: AccountId, online: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ accountId: model.accountId, online: model.online }),
      dependenciesToStream: ({ accountId, online }) =>
        online
          ? Stream.unwrap(
              Effect.gen(function* () {
                const bank = yield* CustomerApi.Client;
                return bank.Statement.events(accountId);
              }),
            ).pipe(
              Stream.map(({ event, envelope }) =>
                Message.GotLine({ commandId: envelope.commandId, line: event }),
              ),
              Stream.catch((error) => Stream.succeed(Message.FailedWatch({ reason: error._tag }))),
            )
          : Stream.empty,
    },
  ),
}));

// VIEW

/** How an unacknowledged line will move the balance once it is confirmed. */
const signed = (line: Line) =>
  line.kind === "deposit" ||
  line.kind === "transfer-in" ||
  line.kind === "refund" ||
  line.kind === "settlement"
    ? line.amount
    : -line.amount;

/**
 * The balance to show: the newest confirmed balance (the statement's, so it
 * moves with the lines it confirms), plus every unacknowledged line. Nothing
 * here is committed, so a line the account later rejects simply stops
 * counting.
 */
export const shownBalance = (model: Model): number | null => {
  if (model.balance === null) return null;
  const confirmed = model.lines.find((l) => l.ack === "confirmed")?.balance ?? model.balance;
  return model.lines
    .filter((l) => l.ack === "pending" || l.ack === "queued")
    .reduce((sum, l) => sum + signed(l), confirmed);
};

const button = "bg-black text-white hover:bg-gray-700 px-4 py-2";

const cents = (amount: number) => (amount / 100).toFixed(2);

const lineView = (line: Line, h: HtmlBuilder<Message>) => {
  const text = `${line.kind} ${cents(line.amount)}`;
  switch (line.ack) {
    case "pending":
      return h.li([h.Class("text-gray-400 italic")], [`${text}, sending`]);
    case "queued":
      return h.li([h.Class("text-amber-600 italic")], [`${text}, queued until online`]);
    case "rejected":
      return h.li([h.Class("text-red-600 line-through")], [`${text}, rejected: ${line.reason}`]);
    case "confirmed":
      return h.li([], [`${text}, balance ${cents(line.balance ?? 0)}`]);
  }
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const balance = shownBalance(model);
  const unacknowledged = model.lines.some((l) => l.ack === "pending" || l.ack === "queued");
  return {
    title: balance === null ? "Bank" : `Balance: ${cents(balance)}`,
    body: h.div(
      [h.Class("flex flex-col gap-4 p-8")],
      [
        h.p([], [`Signed in as ${model.customerId}`]),
        ...(model.online
          ? []
          : [
              h.p(
                [h.Class("text-amber-600")],
                ["Offline: changes are kept and sent when you reconnect."],
              ),
            ]),
        ...(balance === null
          ? [h.button([h.OnClick(Message.ClickedRegister()), h.Class(button)], ["Open my account"])]
          : [
              h.div(
                [
                  h.Class(
                    unacknowledged ? "text-4xl font-bold text-gray-400" : "text-4xl font-bold",
                  ),
                ],
                [unacknowledged ? `${cents(balance)} (pending)` : cents(balance)],
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
```

The app signs in once, which sets an `HttpOnly`, `SameSite=Strict` session cookie, then connects with `Api.protocolWebSocket` on its own origin. The browser sends the cookie with every call and every watch's WebSocket upgrade, so no token appears in a URL or in script. Its subscriptions are pushed by the Durable Objects behind them.

```ts
// src/web/entry.ts
import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { CustomerId } from "../Customer/CustomerId.ts";
import { CustomerApi } from "../CustomerApi/CustomerApi.ts";
import { Flags, Intent, init, intentsKey, Model, subscriptions, update, view } from "./Bank.ts";

/**
 * The signed-in customer. A demo stand-in for a login: `?customer=c-2` picks
 * who you are, defaulting to `c-1`.
 */
const signedIn = Effect.sync(() =>
  CustomerId.make(new URLSearchParams(location.search).get("customer") ?? "c-1"),
);

/** Intents an earlier page load could not deliver. Anything unreadable is dropped. */
const savedIntents = (customerId: CustomerId) =>
  Effect.sync(() =>
    Option.getOrElse(
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Intent)))(
        localStorage.getItem(intentsKey(customerId)) ?? "[]",
      ),
      () => [],
    ),
  );

/** Sign in: the Api sets an `HttpOnly` session cookie on this origin. */
const signIn = Effect.fn(function* (customerId: CustomerId) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  yield* client.execute(
    HttpClientRequest.post("/api/session").pipe(HttpClientRequest.bodyJsonUnsafe({ customerId })),
  );
});

/**
 * The bank Api for the life of the app, on this origin, so the browser sends
 * the session cookie with every call and every watch. Commands go over HTTP;
 * each watch is a WebSocket to the Durable Object that owns what it reads,
 * which pushes every change.
 */
const BankConnection = Layer.unwrap(
  Effect.gen(function* () {
    // The app cannot run signed out.
    yield* signIn(yield* signedIn).pipe(Effect.orDie);
    return CustomerApi.layerClient.pipe(
      Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

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
    flags: Effect.gen(function* () {
      const customerId = yield* signedIn;
      return {
        customerId,
        // Names this page's commands, so each is unique even across reloads.
        session: crypto.randomUUID(),
        online: navigator.onLine,
        intents: yield* savedIntents(customerId),
      };
    }),
  },
);
```

## Local first

How local an app is depends on who is the authority for what the user does. There are four variants. Fold supports the first two today, and this app does both in its foldkit code, with nothing extra in the framework.

### 1. Online, with optimistic UI

The server is the authority, and the app shows a change before the server confirms it. A click adds a line marked `pending` and sends the command with a `commandId` the app chose. The Statement event carrying the same `commandId` confirms it. A typed rejection marks it `rejected`.

The balance shown is the server's confirmed balance plus every unacknowledged line. Nothing is committed locally, so a rejected line just stops counting, and there is nothing to roll back. Confirmation comes from the stream, not the reply, because the event can arrive first.

### 2. Offline-capable, recording intents

The app records what the user asked for (an intent), never a fact the server owns. If the server can't be reached, a line is `queued`, and later ones queue behind it so a withdrawal never overtakes the deposit before it. Unacknowledged intents are saved to `localStorage`.

When the browser comes back online, or on the next page load, the queue is sent in order. The statement's history confirms whatever the server already applied. Resends are safe because the account deduplicates by `commandId`. A conflict is just a rejection: a withdrawal made offline against money that is no longer there comes back `InsufficientFunds`, and the shown balance corrects itself.

Both variants live in [`src/web/Bank.ts`](src/web/Bank.ts), above: `ask`, `flush`, `delivered` and `confirm` in UPDATE, and the `Deliver` and `SaveIntents` commands.

### 3. A local mirror of server aggregates (not supported)

Here the browser runs its own copy of an aggregate and commits facts to it offline, and everything the user does next builds on them. If the server later rejects one, everything built on it is wrong. Making that safe takes a rebase engine: keep server-confirmed state apart from a log of pending commands, and recompute everything derived whenever the server state moves. That is a sync engine, and `alchemy/Domain` doesn't have one.

### 4. Local authority, with the server as a backup (not supported)

Here every device accepts changes, so nothing can reject them, and conflicts must be merged. That takes CRDTs, last-writer-wins, or merge rules specific to the domain. The model here, where an aggregate's `decide` may reject, assumes one authority per aggregate, so this would be a different primitive, not a mode of this one.

## Consistency

A transaction covers one aggregate instance: one Durable Object, one writer. There are no cross-instance transactions, and nothing pretends otherwise. Anything wider is a saga whose in-between states are visible in the model, with their own events, compensations and deadlines.

### Make the invariant the aggregate

When a rule spans entities, give the rule its own aggregate, keyed by what it protects. Usernames are unique across all customers, so a username is an instance: two customers claiming the same name race on it, and one wins.

```ts
// src/Customer/UsernameClaim.ts
import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";
import { ClaimUsername, UsernameClaimed, UsernameTaken } from "./ClaimUsername.ts";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

/**
 * One username, and who holds it. Uniqueness spans every customer, so the
 * invariant is its own aggregate, keyed by the username: two customers
 * claiming the same name race on this one instance, and one of them wins.
 */
export class UsernameClaim extends Domain.Aggregate("UsernameClaim", {
  id: Username,
  state: Schema.Union([
    Schema.TaggedStruct("Free", {}),
    Schema.TaggedStruct("Claimed", { customerId: CustomerId }),
  ]),
  initial: { _tag: "Free" },
  commands: [ClaimUsername],
  decide: {
    ClaimUsername: (s, cmd) =>
      s._tag === "Free"
        ? [new UsernameClaimed({ customerId: cmd.customerId })]
        : s.customerId === cmd.customerId
          ? []
          : new UsernameTaken(),
  },
  evolve: {
    UsernameClaimed: (_, e) => ({ _tag: "Claimed" as const, customerId: e.customerId }),
  },
}) {}
```

### Reserve first, then commit

A saga takes the step that protects the invariant, or that can't be undone, first. Registration claims the username before the customer is registered, so a taken name never opens an account:

```ts
// src/Customer/UsernameReservation.ts
import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import { ClaimUsername } from "./ClaimUsername.ts";
import { ConfirmRegistration } from "./ConfirmRegistration.ts";
import { Customer } from "./Customer.ts";
import { RegistrationRequested } from "./RegisterCustomer.ts";
import { RejectRegistration } from "./RejectRegistration.ts";
import { UsernameClaim } from "./UsernameClaim.ts";

/**
 * Reserve first, then commit: claim the username, and only then register the
 * customer. Nothing downstream (the main account) happens for a registration
 * whose username is taken.
 */
export class UsernameReservation extends Domain.Policy("UsernameReservation", {
  from: Customer,
  on: [RegistrationRequested],
}) {}

export const UsernameReservationLive = UsernameReservation.toLayer(
  Effect.gen(function* () {
    const claims = yield* UsernameClaim;
    const customers = yield* Customer;
    return Effect.fn(function* ({ source, event }) {
      yield* claims.send(event.username, new ClaimUsername({ customerId: source.id })).pipe(
        Effect.andThen(customers.send(source, new ConfirmRegistration())),
        Effect.catchTag("UsernameTaken", () =>
          customers.send(source, new RejectRegistration({ reason: "username taken" })),
        ),
      );
    });
  }),
);
```

Transfers debit before they credit, for the same reason: money can be in flight, but never created. When the credit can't happen, `TransferExecution` refunds the debit.

### Deadlines are scheduled commands

A saga that waits needs a deadline. Large transfers wait for a support agent's approval; if nobody approves in time, a scheduled command expires them. Approval and expiry are commands on the same Transfer, so exactly one of them wins:

```ts
// src/Transfer/TransferApprovalDeadline.ts
import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import { ExpireTransfer } from "./ExpireTransfer.ts";
import { TransferRequested } from "./RequestTransfer.ts";
import { Transfer } from "./Transfer.ts";

/** How long a support agent has to approve a large transfer. */
export const APPROVAL_WINDOW = "24 hours";

/**
 * Whenever a transfer needs approval, expire it if nobody approves it in time.
 * The Transfer decides the race: approval and expiry are commands on the same
 * instance, so exactly one of them wins.
 */
export class TransferApprovalDeadline extends Domain.Policy("TransferApprovalDeadline", {
  from: Transfer,
  on: [TransferRequested],
}) {}

export const TransferApprovalDeadlineLive = TransferApprovalDeadline.toLayer(
  Effect.gen(function* () {
    const transfers = yield* Transfer;
    return Effect.fn(function* ({ source, event }) {
      if (!event.needsApproval) return;
      yield* transfers.schedule(source, new ExpireTransfer(), { after: APPROVAL_WINDOW });
    });
  }),
);
```

Only commands that never reject can be scheduled. `ExpireTransfer` reports that the window closed, and records nothing if the transfer was already approved.

## Layout

Folders are subdomains; every file is named after the thing it declares.

```
src/
  Account/      Account (aggregate: state, decide, evolve, reply, read), one file per command
                (WithdrawMoney: WithdrawMoney + MoneyWithdrawn + DailyLimitExceeded), shared
                rejections (NotOpen, NotOwner, Frozen, InsufficientFunds), mustOwn (read rule),
                AccountSummary, Statement, AccountActivity (views), AccountId
  Customer/     Customer, RegisterCustomer, ConfirmRegistration, RejectRegistration,
                UsernameClaim (uniqueness as an aggregate), ClaimUsername,
                UsernameReservation (reserve-first policy), CustomerDashboard (view of a
                view), MainAccountProvisioning (policy)
  Transfer/     Transfer (process manager state), RequestTransfer, ApproveTransfer,
                ExpireTransfer, CompleteTransfer, FailTransfer, TransferExecution (policy),
                TransferApprovalDeadline (schedules the expiry), TransferStatus (multi-source
                view), AccountTransfers (one event routed to two accounts)
  Fraud/        FraudCheck (port), SiftFraudCheck (adapter), DailyOutflow (stateful view emitting
                DailyOutflowExceeded), FraudReview (policy on that view)
  Settlement/   Payments (port), StripePayments (adapter), SettlementRefund (policy),
                StripeSettlements (Stripe.consumeEvents: payment_intent.succeeded → RecordSettlement)
  CustomerApi/  the customer app's Api
  SupportApi/   the support console's Api, over the same Bank
  Session.ts, CurrentActor.ts, MfaChallenge.ts   authentication and step-up
  Bank.ts       the Domain
  BankWorker.ts the Worker: both Apis + Stripe events, hosted on Durable Objects
  web/          the foldkit app: Bank.ts (model, messages, commands, subscriptions, view)
                entry.ts (signs in, then boots it with the bank client as a resource)
                and worker.ts (serves the build, forwards /api to the bank)
```

## Hosting

The model is hosted by whichever `Domain.Platform` Layer is provided. On Cloudflare every aggregate, view and policy becomes a Durable Object class, declared while the model's Layer is built. See [`BankWorker.ts`](src/BankWorker.ts); swap `DomainCloudflare.DurableObjects` for `Domain.InMemory` and nothing else changes.

The app and the Api share one origin: the app's Worker serves the client build and forwards `/api` to the bank over a service binding, so the session cookie is first-party.

```ts
// src/web/worker.ts
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * The app's Worker: the client build, plus `/api` forwarded to the bank over
 * a service binding. One origin for both, so the session cookie is
 * first-party and reaches every call and every live read's WebSocket.
 */
export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly BANK: Fetcher }) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api") ? env.BANK.fetch(request) : env.ASSETS.fetch(request);
  },
};
```

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import BankWorker from "./src/BankWorker.ts";

export default Alchemy.Stack(
  "CloudflareDomainExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bank = yield* BankWorker;
    // The foldkit app, built with Vite. Its Worker serves the build and
    // forwards /api to the bank, so the app and the Api share one origin.
    const app = yield* Cloudflare.Website.Foldkit("BankApp", {
      main: "src/web/worker.ts",
      env: { BANK: bank },
      assets: { runWorkerFirst: ["/api", "/api/*"] },
    });
    return { url: bank.url.as<string>(), app: app.url.as<string>() };
  }),
);
```

## Tests

```sh
pnpm vitest run test/Bank.story.test.ts     # stories: given / when / then, ports resolved, no mocks
pnpm vitest run test/CustomerApi.test.ts    # both Apis in-process, principals via the session
pnpm vitest run test/HttpTransport.test.ts  # the Worker's HTTP surface on a real HTTP server
pnpm vitest run test/web.test.ts            # the foldkit app's update, with foldkit stories
bun test test/integ.test.ts                 # deploys to Cloudflare (+ a Stripe webhook endpoint) and drives the Api
STRIPE_TEST_REAL_DELIVERY=1 bun test test/integ.test.ts   # also pays with a test card and waits for the settlement
```

## Deploy

```sh
bun run deploy
```
