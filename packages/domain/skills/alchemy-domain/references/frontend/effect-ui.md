# Effect UI

`@alchemy.run/domain/EffectUI` turns a Domain Api into Effect UI Commands, queries and Subscriptions. It is experimental, and `@effect/ui` is not on npm yet: install it from a pkg.pr.new snapshot. The snippets below use the bank example's `CustomerApi` (`examples/cloudflare-domain`).

More: [Integrate with Effect UI](https://alchemy.run/domain/effect-ui).

## Derive the services

Make the services once, with what each command does to the query cache:

```ts
// packages/web/src/Bank.ts
import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import * as Option from "effect/Option";

export const Bank = DomainEffectUI.make(CustomerApi, {
  queries: { AccountLedger: { take: 20, key: (row) => row.id } },
  commands: {
    DepositMoney: {
      // The ledger gains a row: fetch it again.
      invalidates: ({ input }, queries) => [
        queries.AccountLedger.entry({ input: { account: input.accountId } }),
      ],
      // Show the deposit in the summary while it runs.
      optimistic: ({ input }, queries) => [
        queries.AccountSummary.patch({ key: input.accountId }, (snapshot) => ({
          ...snapshot,
          state: Option.map(snapshot.state, (summary) => ({
            ...summary,
            balance: summary.balance + input.amount,
          })),
        })),
      ],
    },
  },
});
```

Each Api command becomes a `Command.Service`, each query a `Query.Service` (paged: `Query.InfiniteService`), and each View a `Query.StreamService` keyed by its read key. Never keep command ids in the Model: the Command makes one, and hydration or history restore would send a stored one again.

More: [Integrate with Effect UI: Update the query cache](https://alchemy.run/domain/effect-ui#update-the-query-cache).

## Send a command

Map the Command's success and its typed failure where `update` issues it. Retry `Unknown` with the `commandId` it carries, since the write may have committed:

```ts
// packages/web/src/Deposit.ts
import { AccountId } from "@bank/domain/Account/Account.id";
import { Command, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import * as Schema from "effect/Schema";
import { Bank } from "./Bank.ts";

export const DepositMessage = UiSchema.TaggedEnum({
  ClickedDeposit: {},
  ClickedRetry: { commandId: Schema.String },
  SucceededDeposit: { balance: Schema.Number },
  FailedDeposit: { failure: Bank.DepositMoney.error },
});

// Deposit 10.00. Pass the `commandId` of an `Unknown` failure to retry that write.
const deposit = (accountId: AccountId, commandId?: string) =>
  Bank.DepositMoney.make({ input: { accountId, amount: 1_000 }, commandId }).pipe(
    Command.match({
      onSuccess: ({ reply }) => DepositMessage.SucceededDeposit({ balance: reply.balance }),
      onFailure: (failure) => DepositMessage.FailedDeposit({ failure }),
    }),
  );

export const Deposit = Html.component({
  name: "Deposit",
  props: Schema.Struct({ accountId: AccountId }),
  model: Schema.Struct({
    balance: Schema.NullOr(Schema.Number),
    failure: Schema.NullOr(Bank.DepositMoney.error),
  }),
  message: DepositMessage,
}).make({
  init: () => ({ balance: null, failure: null }),
  update: {
    ClickedDeposit: ($) => $.run(deposit($.props.accountId)),
    ClickedRetry: ($, { commandId }) => $.run(deposit($.props.accountId, commandId)),
    SucceededDeposit: ($, { balance }) => $.evolve({ balance, failure: null }),
    FailedDeposit: ($, { failure }) => $.evolve({ failure }),
  },
  view: (h, model) =>
    h.div(
      h.button.on("click", DepositMessage.ClickedDeposit()).children("Deposit 10.00"),
      model.balance !== null && h.p.attr("aria-label", "Balance").children(String(model.balance)),
      model.failure?._tag === "Unknown"
        ? h.button
            .on("click", DepositMessage.ClickedRetry({ commandId: model.failure.commandId }))
            .children("Retry")
        : model.failure !== null && h.p.attr("role", "alert").children(model.failure._tag),
    ),
});
```

More: [Integrate with Effect UI: Send a command](https://alchemy.run/domain/effect-ui#send-a-command), [Wait for the views](https://alchemy.run/domain/effect-ui#wait-for-the-views).

## Show a View

Declare a View in the component's `queries`. Every component reading the same key shares one entry and one open stream, a server render ships its first element, and the browser follows it live:

```ts
// packages/web/src/Summary.ts
import { AccountId } from "@bank/domain/Account/Account.id";
import { UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { Bank } from "./Bank.ts";

export const Summary = Html.component({
  name: "Summary",
  props: Schema.Struct({ accountId: AccountId }),
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({}),
  queries: {
    summary: { query: Bank.AccountSummary, args: ({ props }) => ({ key: props.accountId }) },
  },
}).make({
  init: () => ({}),
  update: {},
  view: (h) =>
    Option.match(AsyncResult.value(h.queries.summary), {
      onNone: () => h.p(h.queries.summary._tag === "Failure" ? "Not available" : "Loading"),
      onSome: ({ state }) =>
        h.p
          .attr("aria-label", "Balance")
          .children(
            Option.match(state, { onNone: () => "No account", onSome: (s) => String(s.balance) }),
          ),
    }),
});
```

When `update` must handle each snapshot as a Message, follow the View with `Bank.AccountSummary.watch` in `subscriptions` instead. Follow an event feed with `events`, passing the applied cursor as `after`.

More: [Integrate with Effect UI: Show a View](https://alchemy.run/domain/effect-ui#show-a-view), [Follow a View with Subscriptions](https://alchemy.run/domain/effect-ui#follow-a-view-with-subscriptions).

## Mount the app

Sign in first, so the browser carries an `HttpOnly`, `SameSite=Strict` session cookie on the same origin, including on every WebSocket upgrade. Then mount the app with `Bank.layer`, `CommandHeaders` under it, and the Api client:

```ts
// packages/web/src/entry.ts
import * as Domain from "@alchemy.run/domain";
import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { AccountId } from "@bank/domain/Account/Account.id";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { Component } from "@effect/ui";
import { BrowserHost } from "@effect/ui/html";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";
import * as Socket from "effect/socket/Socket";
import { Bank } from "./Bank.ts";
import { Summary } from "./Summary.ts";

// Read on every call and every query fetch: pass headers the app owns.
const Headers = Layer.succeed(DomainEffectUI.CommandHeaders, {
  get: () => Effect.succeed({ "x-app-version": "1.0.0" }),
});

// The browser sends the session cookie on every call and every WebSocket.
const Connection = CustomerApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);

// Send the app's spans to the server's relay, on this origin.
const Tracing = OtlpTracer.layer({
  url: `${location.origin}/api/telemetry/v1/traces`,
  resource: { serviceName: "bank-web" },
}).pipe(Layer.provide(OtlpSerialization.layerJson));

const App = Summary.pipe(Component.provide(Bank.layer.pipe(Layer.provide(Headers))));

const Main = BrowserHost.mount(
  App,
  { accountId: AccountId.make("c-1-main") },
  document.getElementById("app")!,
).pipe(
  Layer.provide(Layer.mergeAll(Connection, Tracing)),
  // Commands and spans both go over HTTP.
  Layer.provide(FetchHttpClient.layer),
);

Layer.launch(Main).pipe(Effect.runFork);
```

The tracer exports the app's spans to its own origin: Effect UI runs every Command in a span, and Api calls carry the trace to the server. Collect them in the server Worker with `Telemetry.relay`, which forwards them with the server's credentials. Never put an ingest token in the browser.

More: [Integrate with Effect UI: Provide the client and headers](https://alchemy.run/domain/effect-ui#provide-the-client-and-headers), [Observability: Trace the browser](https://alchemy.run/domain/observability#trace-the-browser).

## Test with Stories, Scenes and Plays

A Story drives `update` and a Scene drives the view, with no server or browser: a Command stays pending until the test resolves or fails it, and a query has no value until the test loads one. A Play runs the real component over the in-memory Api client, built inside the tree:

```ts
// packages/web/test/Deposit.test.ts
import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { AccountId } from "@bank/domain/Account/Account.id";
import { Component } from "@effect/ui";
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing";
import { TestHost } from "@effect/ui/testing";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Client } from "./Client.ts";
import { Bank } from "../src/Bank.ts";
import { Deposit } from "../src/Deposit.ts";

// Every command id this test sends is "test:0", so a retry is easy to assert.
const PinnedIds = Layer.succeed(DomainEffectUI.NewCommandId, Effect.succeed("test:0"));

it.effect("a deposit to an account that isn't open is refused", () =>
  Effect.gen(function* () {
    const play = yield* HtmlPlay.make(
      Deposit.pipe(
        // The adapter and the in-memory client are built inside the tree, so the test
        // host waits for their work.
        Component.provide(Bank.layer.pipe(Layer.provide(PinnedIds), Layer.provideMerge(Client))),
      ),
      { accountId: AccountId.make("c-1-main") },
    );
    yield* play.click(HtmlLocator.role("button", { name: "Deposit 10.00" }));
    yield* play.expect(HtmlLocator.role("alert")).toHaveText("Rejected");
  }).pipe(Effect.scoped, Effect.provide(TestHost.layer())),
);
```

Export the component before `Component.provide` (`BankNoDeps`) for Stories and Scenes. Test a `Command.Service` of your own with `MyCommand.make(args).effect` under its Layer.

More: [Integrate with Effect UI: Test a component with the model](https://alchemy.run/domain/effect-ui#test-a-component-with-the-model), [Tutorial part 6: Test the app](https://alchemy.run/domain/tutorial/part-6#test-the-app).

## Host the app

`Cloudflare.Website.EffectUI` builds the app with Vite and deploys its Worker. Serve it and the Api from one origin as [index.md](index.md#serve-the-app-and-the-api-from-one-origin) shows.

More: [Cloudflare: Effect UI](https://alchemy.run/cloudflare/frontend/effect-ui).
