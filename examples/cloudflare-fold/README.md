# cloudflare-fold

A bank built with `alchemy/Fold`: aggregates, views, policies and ports declared as pure, typed definitions, exposed through two Apis, hosted on Cloudflare Durable Objects, and driven from a foldkit app.

An Api exposes commands (writes) and views and aggregates (reads). Each one is a security boundary: its middleware authenticates the caller, and its `decide` or `validate` decides what that caller may do or see.

## Commands

A command lives in its own file with the events it records and the rejections only it returns. Its middleware authenticates the caller and provides who is acting:

```ts
// src/Customer/RegisterCustomer.ts
import { Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Session } from "../Session.ts";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

/** The customer is registered, or a registration is already in progress. */
export class AlreadyRegistered extends Rejection.make("AlreadyRegistered") {}

/** A customer may only register themselves. */
export class NotTheCustomer extends Rejection.make("NotTheCustomer") {}

/** Registration waits for `UsernameReservation` to claim the username. */
export class RegistrationRequested extends Event.make("RegistrationRequested", {
  data: { name: Schema.String, username: Username },
}) {}

/**
 * Sign up as a customer under a unique username. The customer is registered
 * once the username is claimed; `MainAccountProvisioning` then opens their
 * main account.
 */
export class RegisterCustomer extends Command.make("RegisterCustomer", {
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
  Option.match(Option.orElse(fromCookie(headers), () => fromAuthorization(headers)), {
    onNone: () => Effect.fail(new Unauthorized()),
    onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
  }),
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
  if (Option.isNone(body)) return HttpServerResponse.text("Expected { customerId }", { status: 400 });
  return HttpServerResponse.empty({ status: 204 }).pipe(
    HttpServerResponse.setCookieUnsafe(SESSION_COOKIE, `customer:${body.value.customerId}`, options),
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
import { Aggregate } from "alchemy/Fold";
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
export class Customer extends Aggregate.make("Customer", {
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
import { View } from "alchemy/Fold";
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
export class AccountSummary extends View.make("AccountSummary", {
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
import { Api } from "alchemy/Fold";
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
export class CustomerApi extends Api.make(
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
import type { Api } from "alchemy/Fold";
import * as Effect from "effect/Effect";
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

export const Flags = Schema.Struct({ customerId: CustomerId });
export type Flags = typeof Flags.Type;

// MODEL

export const Model = Schema.Struct({
  customerId: CustomerId,
  accountId: AccountId,
  /** `null` until the main account exists (register to open it). */
  balance: Schema.NullOr(Schema.Number),
  lines: Schema.Array(StatementLine),
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
  GotBalance: { balance: Schema.NullOr(Schema.Number) },
  GotLine: { line: StatementLine },
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

export const Deposit = Command.define("Deposit", {
  args: { accountId: AccountId, amount: Schema.Number },
  messages: [Message.SucceededCommand, Message.FailedCommand],
  execute: ({ accountId, amount }) =>
    Effect.gen(function* () {
      const bank = yield* CustomerApi.Client;
      yield* bank.DepositMoney({ target: accountId, amount });
      return Message.SucceededCommand();
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedCommand({ reason: error._tag })))),
});

export const Withdraw = Command.define("Withdraw", {
  args: { accountId: AccountId, amount: Schema.Number },
  messages: [Message.SucceededCommand, Message.FailedCommand],
  execute: ({ accountId, amount }) =>
    Effect.gen(function* () {
      const bank = yield* CustomerApi.Client;
      yield* bank.WithdrawMoney({ target: accountId, amount }, mfa);
      return Message.SucceededCommand();
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedCommand({ reason: error._tag })))),
});

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message, Bank> =>
  Message.match<Update.Return<Model, Message, Bank>>(message, {
    ClickedRegister: () => ({ model, commands: [Register({ customerId: model.customerId })] }),
    ClickedDeposit: () => ({
      model,
      commands: [Deposit({ accountId: model.accountId, amount: 1_000 })],
    }),
    ClickedWithdraw: () => ({
      model,
      commands: [Withdraw({ accountId: model.accountId, amount: 1_000 })],
    }),
    // State arrives through the subscriptions; a command's success only clears the error.
    SucceededCommand: () => ({ model: { ...model, error: null } }),
    FailedCommand: ({ reason }) => ({ model: { ...model, error: reason } }),
    GotBalance: ({ balance }) => ({ model: { ...model, balance } }),
    GotLine: ({ line }) => ({ model: { ...model, lines: [line, ...model.lines] } }),
    FailedWatch: ({ reason }) => ({ model: { ...model, error: `watch ended: ${reason}` } }),
  });

// INIT: the signed-in customer's main account.

export const init = (flags: Flags): Update.Return<Model, Message, Bank> => ({
  model: {
    customerId: flags.customerId,
    accountId: mainAccountId(flags.customerId),
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
      h.p([], [`Signed in as ${model.customerId}`]),
      ...(model.balance === null
        ? [h.button([h.OnClick(Message.ClickedRegister()), h.Class(button)], ["Open my account"])]
        : [
            h.div([h.Class("text-4xl font-bold")], [cents(model.balance)]),
            h.div(
              [h.Class("flex gap-2")],
              [
                h.button([h.OnClick(Message.ClickedDeposit()), h.Class(button)], ["Deposit 10.00"]),
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
        model.lines.map((line) =>
          h.li([], [`${line.kind} ${cents(line.amount)}, balance ${cents(line.balance)}`]),
        ),
      ),
    ],
  ),
});
```

The app signs in once, which sets an `HttpOnly`, `SameSite=Strict` session cookie, then connects with `Api.protocolWebSocket` on its own origin. The browser sends the cookie with every call and every watch's WebSocket upgrade, so no token appears in a URL or in script. Its subscriptions are pushed by the Durable Objects behind them.

```ts
// src/web/entry.ts
import { Api } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { CustomerId } from "../Customer/CustomerId.ts";
import { CustomerApi } from "../CustomerApi/CustomerApi.ts";
import { Flags, init, Model, subscriptions, update, view } from "./Bank.ts";

/**
 * The signed-in customer. A demo stand-in for a login: `?customer=c-2` picks
 * who you are, defaulting to `c-1`.
 */
const signedIn = Effect.sync(() =>
  CustomerId.make(new URLSearchParams(location.search).get("customer") ?? "c-1"),
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
      Layer.provide(Api.protocolWebSocket(`${location.origin}/api`)),
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
  { flags: signedIn.pipe(Effect.map((customerId) => ({ customerId }))) },
);
```

## Consistency

A transaction covers one aggregate instance: one Durable Object, one writer. Fold has no cross-instance transactions, and doesn't pretend to. Anything wider is a saga whose in-between states are visible in the model, with their own events, compensations and deadlines.

### Make the invariant the aggregate

When a rule spans entities, give the rule its own aggregate, keyed by what it protects. Usernames are unique across all customers, so a username is an instance: two customers claiming the same name race on it, and one wins.

```ts
// src/Customer/UsernameClaim.ts
import { Aggregate } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { ClaimUsername, UsernameClaimed, UsernameTaken } from "./ClaimUsername.ts";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

/**
 * One username, and who holds it. Uniqueness spans every customer, so the
 * invariant is its own aggregate, keyed by the username: two customers
 * claiming the same name race on this one instance, and one of them wins.
 */
export class UsernameClaim extends Aggregate.make("UsernameClaim", {
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
import { Policy } from "alchemy/Fold";
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
export class UsernameReservation extends Policy.make("UsernameReservation", {
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
import { Policy } from "alchemy/Fold";
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
export class TransferApprovalDeadline extends Policy.make("TransferApprovalDeadline", {
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

The Domain is hosted by whichever `FoldPlatform` Layer is provided. On Cloudflare every aggregate, view and policy becomes a Durable Object class, declared while the Domain's Layer is built. See [`BankWorker.ts`](src/BankWorker.ts); swap `FoldCloudflare.DurableObjects` for `Fold.InMemory` and nothing else changes.

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
  "CloudflareFoldExample",
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
