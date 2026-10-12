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

export class AlreadyRegistered extends Rejection.make("AlreadyRegistered") {}

/** A customer may only register themselves. */
export class NotTheCustomer extends Rejection.make("NotTheCustomer") {}

export class CustomerRegistered extends Event.make("CustomerRegistered", {
  data: { name: Schema.String },
}) {}

/** Sign up as a customer; `MainAccountProvisioning` opens their main account. */
export class RegisterCustomer extends Command.make("RegisterCustomer", {
  target: CustomerId,
  input: { name: Schema.String },
  events: [CustomerRegistered],
  rejects: [AlreadyRegistered, NotTheCustomer],
}).middleware(CustomerSession) {}
```

The aggregate implements it. `decide` reads the context the command's middleware provides, and authorizes against the current state:

```ts
// src/Customer/Customer.ts
import { Aggregate } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentActor } from "../CurrentActor.ts";
import { CustomerId } from "./CustomerId.ts";
import {
  AlreadyRegistered,
  CustomerRegistered,
  NotTheCustomer,
  RegisterCustomer,
} from "./RegisterCustomer.ts";

export class Customer extends Aggregate.make("Customer", {
  id: CustomerId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Registered", { name: Schema.String }),
  ]),
  initial: { _tag: "New" },
  commands: [RegisterCustomer],
  decide: {
    RegisterCustomer: Effect.fn(function* (s, cmd, { id }) {
      const actor = yield* CurrentActor;
      if (actor._tag === "Customer" && actor.customerId !== id) return yield* new NotTheCustomer();
      if (s._tag === "Registered") return yield* new AlreadyRegistered();
      return [new CustomerRegistered({ name: cmd.name })];
    }),
  },
  evolve: {
    CustomerRegistered: (_, e) => ({ _tag: "Registered" as const, name: e.name }),
  },
}) {}
```

`CurrentActor` is a `Command.Context`: a service with a schema, so its value travels with the command to the aggregate's Durable Object. `CustomerSession` provides a customer, `SupportAgentSession` an agent, and policies provide the system (`Effect.provideService(CurrentActor, system("FraudReview"))`). A `decide` can only read what its command's middleware provides, and `send` requires it, so a policy that forgets is a type error.

An Api exposes commands directly next to its queries and subscriptions; see [`CustomerApi.ts`](src/CustomerApi/CustomerApi.ts). Only the reads have handler Layers.

## Layout

Folders are subdomains; every file is named after the thing it declares.

```
src/
  Account/      Account (aggregate: state, decide, evolve, reply), one file per command
                (WithdrawMoney: WithdrawMoney + MoneyWithdrawn + DailyLimitExceeded), shared
                rejections (NotOpen, NotOwner, Frozen, InsufficientFunds), AccountSummary (read
                model), Statement (maps six events to StatementLine), AccountActivity
                (pass-through), AccountId
  Customer/     Customer, RegisterCustomer, CustomerDashboard (view of a view),
                MainAccountProvisioning (policy)
  Transfer/     Transfer (process manager state), RequestTransfer, CompleteTransfer, FailTransfer,
                TransferExecution (policy), TransferStatus (multi-source view), AccountTransfers
                (one event routed to two accounts)
  Fraud/        FraudCheck (port), SiftFraudCheck (adapter), DailyOutflow (stateful view emitting
                DailyOutflowExceeded), FraudReview (policy on that view)
  Settlement/   Payments (port), StripePayments (adapter), SettlementRefund (policy),
                StripeSettlements (Stripe.consumeEvents: payment_intent.succeeded → RecordSettlement)
  CustomerApi/  the customer-facing Api: its commands, plus one file per Query / Subscription,
                CustomerSession and MfaChallenge middleware
  SupportApi/   a second audience over the same Bank: FreezeAccount, ChangeOwner, ActivityLog
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
