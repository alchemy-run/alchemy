# Hosting on Cloudflare with alchemy

The server package hosts the model in a Cloudflare Worker. `DomainCloudflare.DurableObjects` declares one Durable Object class per aggregate, view, policy, projection and stream while the Worker builds. It also runs sagas on `Cloudflare.Workflows.DurableObjectEngine`. Each aggregate instance is one Durable Object: one writer, which commits its events, state, idempotency receipt and outbox in a single transaction.

```ts
// packages/server/src/BankWorker.ts
import { Bank, BankHandlers } from "@acme/domain/Bank.model";
import { CustomerApi } from "@acme/domain/CustomerApi.api";
import * as Cloudflare from "alchemy/Cloudflare";
import * as DomainCloudflare from "alchemy/Domain/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { SiftFraudCheck } from "./Fraud/SiftFraudCheck.ts";
import { D1LedgerStore } from "./Ledger/D1LedgerStore.ts";
import { MfaChallengeLive } from "./MfaChallenge.ts";
import { SessionLive, sessionRoute } from "./Session.ts";

/** One Layer: the middleware, the hosted model, and every adapter it needs. */
const BankLive = Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(
  Layer.provideMerge(Bank.layer(BankHandlers)),
  Layer.provideMerge(D1LedgerStore),
  Layer.provide(
    Layer.mergeAll(DomainCloudflare.DurableObjects, SiftFraudCheck, Cloudflare.D1.QueryDatabaseBinding),
  ),
);

export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
  "BankWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const customerApi = yield* CustomerApi.httpEffect;   // resolve once, at init
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/api/session") return yield* sessionRoute;
        if (path.startsWith("/api")) return yield* customerApi;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(BankLive)),   // provide one Layer, once
) {}
```

- Swap `DomainCloudflare.DurableObjects` for `Domain.InMemory` and nothing else changes. That's how the Api tests host the model.
- Resources the adapters need, like a D1 database, are declared in the server package and bound through alchemy bindings (`Cloudflare.D1.QueryDatabase(db)` inside the adapter's Layer).
- Webhooks and event sources, like a Stripe webhook, are yielded in the Worker's init and send commands into the model.
- `alchemy dev` runs everything locally in workerd: Durable Objects, sagas and the foldkit app.

## Live reads

Clients that `watch` or read `events` open a WebSocket per read, with `Domain.protocolWebSocket`. The Worker runs the read's middleware, then hands the socket to the Durable Object that owns the key. That object pushes each committed change, judged by `validate` again, and hibernates in between. Commands go over HTTP.

## Deploying

The root `alchemy.run.ts` yields the server Worker and the foldkit website (see [layout.md](layout.md)). Deploy with `alchemy deploy`, develop with `alchemy dev`, and tear down with `alchemy destroy`.

## Pitfalls

- Durable Object calls right after a fresh deploy can briefly hit alchemy's placeholder script. The Domain platform retries its own calls, so make test readiness probes retry the first real request.
- Never keep per-request objects (sockets, promises) across events in a Durable Object or Worker. Resolve services at init, and do I/O per request.
- Handlers may require `RuntimeContext` (for bindings); every platform provides it when it runs them.
