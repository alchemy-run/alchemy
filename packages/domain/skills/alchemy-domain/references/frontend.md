# foldkit frontends

foldkit is event-driven like the domain. The app's Commands send domain commands, its Subscriptions turn live view reads into Messages, and `update` folds Messages into the Model. The domain package's Api gives the browser a typed client: no hand-written fetch code, no duplicated schemas.

## The Api client as a resource

Build the client once, for the app's life, and give it to foldkit as a resource. Sign in first, so the browser carries an `HttpOnly`, `SameSite=Strict` session cookie on the same origin, including on every WebSocket upgrade.

```ts
// packages/web/src/entry.ts
import { CustomerApi } from "@acme/domain/CustomerApi.api";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { Flags, init, Model, subscriptions, update, view } from "./Bank.ts";

const BankConnection = Layer.unwrap(
  Effect.gen(function* () {
    yield* signIn;   // POST /api/session
    return CustomerApi.layerClient.pipe(
      Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

Runtime.run(
  Runtime.makeApplication({
    Model, Flags, init, update, view, subscriptions,
    resources: BankConnection,
    container: document.getElementById("root"),
  }),
  { flags: Effect.succeed({ /* ... */ }) },
);
```

More: [Integrate with foldkit: Give the app its client](https://alchemy.run/domain/foldkit#give-the-app-its-client).

## Commands call domain commands

```ts
// packages/web/src/Bank.ts
export const Register = Command.define("Register", {
  args: { customerId: CustomerId },
  messages: [Message.SucceededCommand, Message.FailedCommand],
  execute: ({ customerId }) =>
    Effect.gen(function* () {
      const bank = yield* CustomerApi.Client;
      yield* bank.RegisterCustomer({ target: customerId, name: customerId, username: Username.make(customerId) });
      return Message.SucceededCommand();
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedCommand({ reason: error._tag })))),
});
```

Every typed rejection arrives as a tagged error, so `update` can show exactly why something was refused.

To keep a rejection in a Message or the Model, use `CustomerApi.rejections`: one Schema for every rejection the Api's commands declare, decoding to the rejection classes. A helper for every Api takes `A extends Domain.Api.Any` and reads `api.commands`.

More: [Integrate with foldkit: Send domain commands from foldkit commands](https://alchemy.run/domain/foldkit#send-domain-commands-from-foldkit-commands).

## Subscriptions watch views

```ts
export const subscriptions = Subscription.make<Model, Message, Bank>()((entry) => ({
  summary: entry(
    { accountId: AccountId, online: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ accountId: model.accountId, online: model.online }),
      dependenciesToStream: ({ accountId, online }) =>
        online
          ? Stream.unwrap(Effect.gen(function* () {
              const bank = yield* CustomerApi.Client;
              return bank.AccountSummary.watch(accountId);
            })).pipe(
              Stream.map((summary) => Message.GotBalance({ balance: summary?.balance ?? null })),
              Stream.catch((error) => Stream.succeed(Message.FailedWatch({ reason: error._tag }))),
            )
          : Stream.empty,
    },
  ),
}));
```

Watch state with `View.watch(key)`, and watch emitted events with `View.events(key)` (e.g. statement lines). A failed `validate` ends the watch with its rejection.

To show data at first paint, read `View.snapshot(key)` (on the server, or in `init`): it gives `{ state, cursor }` from one read. Start the feed with `View.events(key, { after: cursor })`, so a write between the two reads arrives once and none is missed.

More: [Integrate with foldkit: Watch views with subscriptions](https://alchemy.run/domain/foldkit#watch-views-with-subscriptions).

## Tracing from the browser

foldkit wraps every Command in a span, and Api calls carry the trace to the server (live reads too). Put a tracer in `resources` that exports to the app's own origin, and collect it in the server Worker with `Telemetry.relay`, which forwards it with the server's credentials:

```ts
// packages/web/src/entry.ts
const Tracing = OtlpTracer.layer({
  url: `${location.origin}/api/telemetry/v1/traces`,
  resource: { serviceName: "bank-web" },
}).pipe(Layer.provide(OtlpSerialization.layerJson));
const Resources = Layer.mergeAll(BankConnection, Tracing).pipe(Layer.provide(FetchHttpClient.layer));

// packages/server/src/BankWorker.ts
import * as Telemetry from "alchemy/Telemetry";
const telemetry = Telemetry.relay({
  authorize: Effect.map(HttpServerRequest, (r) => Option.isSome(actorOf(r.headers))),   // signed-in only
  // route: (signal, configured) => Effect.succeed(configured),                       // choose destinations
});
if (path.startsWith("/api/telemetry/")) return yield* telemetry;
```

Never put an ingest token in the browser. Workers Observability can't receive browser spans, so relay them to an OTLP destination (Axiom, a collector).

More: [Observability: Trace the browser](https://alchemy.run/domain/observability#trace-the-browser).

## Optimistic updates and offline

- **Optimistic UI.** Send each command with a `commandId` the app chooses, and show it as pending. The view event carrying that `commandId` confirms it, and a typed rejection marks it rejected. Show the server's balance plus every unacknowledged line, so nothing is ever rolled back.
- **Offline intents.** Record what the user asked for, never facts the server owns. Queue unreachable sends in order and persist them to `localStorage`. Deliver them when back online, deduplicated by `commandId`. A conflict is just a typed rejection.

- **Predicted outcome.** `MyAggregate.predict(state, command, { id, now, context })` runs the aggregate's own `decide` and `evolve`: `Accepted` (events, envelopes, next state), `Rejected` (the same rejection the server returns), or `Unpredictable` (only the server can tell: `decide` suspended, died, or broke its declaration). `MyView.evolve(state, { name, event, source, envelope })` folds a predicted event like the server's view. `context` is required, by type, for whatever the command's middleware provides: build it from a client-side Layer of the same services (`yield* Layer.build(ClientSession)`). Still confirm from the stream.

A local mirror of server aggregates, or local-authority sync, isn't supported. It needs a sync engine or CRDTs.

More: [Optimistic updates](https://alchemy.run/domain/optimistic-updates), [Offline and local first](https://alchemy.run/domain/local-first).

## Hosting the app

`Cloudflare.Website.Foldkit` builds the app with Vite and serves it from its own Worker. That Worker forwards `/api` to the server over a service binding, so the app and the Api share one origin:

```ts
// packages/web/src/worker.ts
export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly BANK: Fetcher }) {
    return new URL(request.url).pathname.startsWith("/api") ? env.BANK.fetch(request) : env.ASSETS.fetch(request);
  },
};
```

More: [Integrate with foldkit: Build and host it](https://alchemy.run/domain/foldkit#build-and-host-it).

## Testing the app

Test `update` and the Commands with foldkit stories (`foldkit/story`) in `packages/web/test`. They need no server.

More: [Integrate with foldkit: Test the app's update](https://alchemy.run/domain/foldkit#test-the-apps-update).
