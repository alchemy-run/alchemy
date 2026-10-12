# cloudflare-fold

A bank built with `alchemy/Fold`: aggregates, views, policies and ports declared as pure, typed definitions, exposed through two Apis, and hosted on Cloudflare Durable Objects.

## Commands

A command lives in its own file with the events it records and the rejections only it returns. Its middleware authenticates the caller and provides who is acting:

```ts
// src/Customer/RegisterCustomer.ts
import { Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerSession } from "../CustomerApi/CustomerSession.ts";
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
  input: { name: Schema.String, username: Username },
  events: [RegistrationRequested],
  rejects: [AlreadyRegistered, NotTheCustomer],
}).middleware(CustomerSession) {}
```

The aggregate implements it. `decide` reads the context the command's middleware provides, and authorizes against the current state. Registration is a small saga (see [Consistency](#consistency)), so `Customer` also handles the commands that confirm or reject it:

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

`CurrentActor` is a `Command.Context`: a service with a schema, so its value travels with the command to the aggregate's Durable Object. `CustomerSession` provides a customer, `SupportAgentSession` an agent, and policies provide the system (`Effect.provideService(CurrentActor, system("FraudReview"))`). A `decide` can only read what its command's middleware provides, and `send` requires it, so a policy that forgets is a type error.

An Api exposes commands directly next to its queries and subscriptions; see [`CustomerApi.ts`](src/CustomerApi/CustomerApi.ts). Only the reads have handler Layers.

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
  Account/      Account (aggregate: state, decide, evolve, reply), one file per command
                (WithdrawMoney: WithdrawMoney + MoneyWithdrawn + DailyLimitExceeded), shared
                rejections (NotOpen, NotOwner, Frozen, InsufficientFunds), AccountSummary (read
                model), Statement (maps six events to StatementLine), AccountActivity
                (pass-through), AccountId
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
  CustomerApi/  the customer-facing Api: its commands, plus one file per Query / Subscription,
                CustomerSession and MfaChallenge middleware
  SupportApi/   a second audience over the same Bank: FreezeAccount, ChangeOwner,
                ApproveTransfer, ActivityLog
  CurrentActor.ts  who is acting, provided by the session middleware
  Bank.ts       the Domain
  BankWorker.ts the Worker: both Apis + Stripe events, hosted on Durable Objects
```

## Hosting

The Domain is hosted by whichever `FoldPlatform` Layer is provided. On Cloudflare every aggregate, view and policy becomes a Durable Object class, declared while the Domain's Layer is built. See [`BankWorker.ts`](src/BankWorker.ts); swap `FoldCloudflare.DurableObjects` for `Fold.InMemory` and nothing else changes.

## Tests

```sh
pnpm vitest run test/Bank.story.test.ts     # pure stories: given / when / then, ports resolved, no mocks
pnpm vitest run test/CustomerApi.test.ts    # both Apis in-process, principals via middleware
pnpm vitest run test/HttpTransport.test.ts  # the Worker's HTTP surface on a real HTTP server
bun test test/integ.test.ts                 # deploys to Cloudflare (+ a Stripe webhook endpoint) and drives the Api
STRIPE_TEST_REAL_DELIVERY=1 bun test test/integ.test.ts   # also pays with a test card and waits for the settlement
```

## Deploy

```sh
bun run deploy
```
