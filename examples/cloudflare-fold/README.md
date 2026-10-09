# cloudflare-fold

A bank built with `alchemy/Fold`: aggregates, views, feeds, policies and ports declared as pure, typed definitions, exposed through two Apis, and hosted on Cloudflare Durable Objects.

```ts
export class Account extends Aggregate.make("Account", {
  id: AccountId,
  state: AccountState,
  initial: { _tag: "Unopened" },
  commands: [OpenAccount, Deposit, Withdraw, ...],
  events: [AccountOpened, MoneyDeposited, MoneyWithdrawn, ...],
  decide: {
    Withdraw: (s, cmd, { now }) => {
      const o = openFor(s, cmd.by);
      if (o._tag !== "Open") return o;                     // NotOpen | NotOwner
      if (cmd.amount > o.balance) return new InsufficientFunds({ balance: o.balance, requested: cmd.amount });
      return [new MoneyWithdrawn({ amount: cmd.amount, balanceAfter: o.balance - cmd.amount })];
    },
    ...
  },
  evolve: { ... },
  reply: { Withdraw: (s) => ({ balance: ... }) },
}) {}
```

## Layout

Folders are subdomains; every file is named after the thing it declares.

```
src/
  Account/      Account (aggregate + its commands, events, rejections), AccountSummary (view),
                Statement and AccountActivity (feeds), AccountId
  Customer/     Customer, CustomerDashboard (view-to-view), MainAccountProvisioning (policy)
  Transfer/     Transfer (process manager state), TransferExecution (policy),
                TransferStatus (multi-source view), AccountTransfers (fan-out feed)
  Fraud/        FraudCheck (port), SiftFraudCheck (adapter), FraudReview (policy)
  Settlement/   Payments (port), StripePayments (adapter), SettlementRefund (policy),
                StripeSettlements (Stripe.consumeEvents: payment_intent.succeeded → RecordSettlement)
  CustomerApi/  the customer-facing Api: one file per Mutation / Query / Subscription,
                CustomerSession and MfaChallenge middleware
  SupportApi/   a second audience over the same Bank
  Bank.ts       the Domain
  BankWorker.ts the Worker: both Apis + Stripe events, hosted on Durable Objects
```

## Hosting

The Domain is hosted by whichever `FoldPlatform` Layer is provided. On Cloudflare every aggregate, view, feed and policy becomes a Durable Object class, declared while the Domain's Layer is built:

```ts
const BankLive = Layer.mergeAll(CustomerApiLive, SupportApiLive, CustomerSessionLive, ...).pipe(
  Layer.provideMerge(Bank.layer(BankPolicies)),
  Layer.provide(Layer.mergeAll(FoldCloudflare.DurableObjects, SiftFraudCheck, StripePayments)), // or Fold.InMemory
);
```

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
