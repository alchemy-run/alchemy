# Hosting on Cloudflare with alchemy

The server package hosts the model in a Cloudflare Worker. `DomainCloudflare.layerDurableObjects()` declares one Durable Object class per aggregate, view, policy, projection and stream while the Worker builds. It also runs sagas on `Cloudflare.Workflows.layerDurableObjectEngine()`. Each aggregate instance is one Durable Object: one writer, which commits its events, state, idempotency receipt and outbox in a single transaction.

```ts
// packages/server/src/BankWorker.ts
import { Bank, BankHandlers } from "@acme/domain/Bank.model";
import { CustomerApi } from "@acme/domain/CustomerApi.api";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
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
    Layer.mergeAll(DomainCloudflare.layerDurableObjects(), SiftFraudCheck, Cloudflare.D1.QueryDatabaseBinding),
  ),
);

export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
  "BankWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const customerApi = yield* CustomerApi;   // resolve once, at init
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/api/session") return yield* sessionRoute;
        if (path.startsWith("/api")) return yield* customerApi.fetch;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(BankLive)),   // provide one Layer, once
) {}
```

- Swap `DomainCloudflare.layerDurableObjects()` for `Domain.InMemory` and nothing else changes. That's how the Api tests host the model.
- Resources the adapters need, like a D1 database, are declared in the server package and bound through alchemy bindings (`Cloudflare.D1.QueryDatabase(db)` inside the adapter's Layer).
- Webhooks and event sources, like a Stripe webhook, are yielded in the Worker's init and send commands into the model.
- `alchemy dev` runs everything locally in workerd: Durable Objects, sagas and the foldkit app.

## Calling the Api in process

Code in the Worker that is not a client of the Api (a webhook route, a scheduled job) calls it with `CustomerApi.clientInProcess`: the same typed client, wired to the handlers in process, with the middleware of everything it serves. When that code has already checked its caller (a webhook signature), it provides a middleware Layer that trusts the caller, to that client only:

```ts
const asSystem = Layer.succeed(Session, (effect) =>
  Effect.provideService(effect, CurrentActor, system("payments-webhook")),
);
const bank = yield* CustomerApi.clientInProcess.pipe(Effect.provide(asSystem));   // per request, in Effect.scoped
yield* bank.DepositMoney(accountId, { amount });
```

- Build `clientInProcess` per request in a Worker. `layerClientInProcess` provides `CustomerApi.Client` in process, for long-lived processes and scripts.
- Do not send a request to the Worker's own URL, and do not pass a verified secret through a header to `clientInProcess` to be checked again.

More: [Api: Call it in process](https://alchemy.run/domain/api#call-it-in-process), [In memory](https://alchemy.run/domain/in-memory).

## Live reads

Clients that `watch` or read `events` open a WebSocket per read, with `Domain.protocolWebSocket`. The Worker runs the read's middleware, then hands the socket to the Durable Object that owns the key. That object pushes each committed change, judged by `validate` again, and hibernates in between. Commands go over HTTP.

More: [Cloudflare: Watch without polling](https://alchemy.run/domain/cloudflare#watch-without-polling).

## Deploying

The root `alchemy.run.ts` yields the server Worker and the foldkit website (see [layout.md](layout.md)). Deploy with `alchemy deploy`, develop with `alchemy dev`, and tear down with `alchemy destroy`.

More: [Cloudflare: Deploy it](https://alchemy.run/domain/cloudflare#deploy-it), [Cloudflare: Deploy without dropping requests](https://alchemy.run/domain/cloudflare#deploy-without-dropping-requests).

## Observability

Every command, event and reaction is traced automatically:
- `Domain.send` and `Domain.decide` spans for commands, with a span event per committed event.
- `Domain.policy` and `Domain.view` spans that continue the trace of the commit they react to.
- `Domain.saga` and `Domain.projection` spans that start their own trace and link back to their cause.
- `Domain.external` spans for external system calls.

All of them carry `domain.correlation_id`, the first command of the flow, which finds a whole flow across traces. Export to an OpenTelemetry backend to see each flow as one connected trace: declare an `Axiom.Dataset` per signal and an `Axiom.ApiToken` that may ingest into them, and add `Axiom.Telemetry({ token, traces, logs })` to the Worker's single `Effect.provide` (or `Alchemy.Telemetry.layerOtlp` for any OTLP endpoint). Name datasets per stage. `Cloudflare.Telemetry()` shows spans in Cloudflare's dashboard instead, but Cloudflare starts a new trace per Worker or Durable Object event, so flows don't connect and browser spans can't be added.

Metrics: `domain.commands`, `domain.command.duration`, `domain.events`, `domain.lag` (commit to handling), `domain.runs`, `domain.projection.batch_size`, `domain.external.calls`. Turn off view spans with `Bank.layer(handlers, { telemetry: { views: false } })`.

More: [Observability](https://alchemy.run/domain/observability).

## Pitfalls

- Durable Object calls right after a fresh deploy can briefly hit alchemy's placeholder script. The Domain platform retries its own calls, so make test readiness probes retry the first real request.
- Never keep per-request objects (sockets, promises) across events in a Durable Object or Worker. Resolve services at init, and do I/O per request.
- Handlers may require `RuntimeContext` (for bindings); every platform provides it when it runs them.

More: [Cloudflare: Know what runs where](https://alchemy.run/domain/cloudflare#know-what-runs-where).
