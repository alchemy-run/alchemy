# foldkit frontends

foldkit is event-driven like the domain. The app's Commands send domain commands, its Subscriptions turn live view reads into Messages, and `update` folds Messages into the Model. The domain package's Api gives the browser a typed client: no hand-written fetch code, no duplicated schemas.

## The Api client as a resource

Build the client once, for the app's life, and give it to foldkit as a resource. Sign in first, so the browser carries an `HttpOnly`, `SameSite=Strict` session cookie on the same origin, including on every WebSocket upgrade.

```ts
// packages/web/src/entry.ts
import { CustomerApi } from "@acme/domain/CustomerApi.api";
import * as Domain from "alchemy/Domain";
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

## Optimistic updates and offline

- **Optimistic UI.** Send each command with a `commandId` the app chooses, and show it as pending. The view event carrying that `commandId` confirms it, and a typed rejection marks it rejected. Show the server's balance plus every unacknowledged line, so nothing is ever rolled back.
- **Offline intents.** Record what the user asked for, never facts the server owns. Queue unreachable sends in order and persist them to `localStorage`. Deliver them when back online, deduplicated by `commandId`. A conflict is just a typed rejection.

A local mirror of server aggregates, or local-authority sync, isn't supported. It needs a sync engine or CRDTs.

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

## Testing the app

Test `update` and the Commands with foldkit stories (`foldkit/story`) in `packages/web/test`. They need no server.
