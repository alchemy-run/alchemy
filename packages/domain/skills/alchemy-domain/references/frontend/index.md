# Frontends

Drive a Domain Api from a browser app in the web package. The Api's client gives the browser typed commands, queries and live reads, with no hand-written fetch code and no copied schemas.

Use [Effect UI](effect-ui.md) for a new app. It is event-driven like the domain: Commands send domain commands, queries and Subscriptions bring reads in, and `update` folds Messages into the Model. Its Stories and Scenes test a component the way the domain's stories test a model, with messages in and Commands and query results out. Keep an app written with [Foldkit](foldkit.md) on its adapter. Any other framework can run the Api's client with an Effect runtime.

More: [Frontends](https://alchemy.run/domain/frontends).

## Serve the app and the Api from one origin

Sign the browser in first, so it holds an `HttpOnly`, `SameSite=Strict` session cookie that reaches every call and every WebSocket upgrade. Serve the app and the Api from one origin to keep that cookie first-party: the app's Worker forwards `/api` to the server over a service binding.

```ts
// packages/web/src/worker.ts
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export default {
  fetch(request: Request, env: { readonly ASSETS: Fetcher; readonly BANK: Fetcher }) {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api") ? env.BANK.fetch(request) : env.ASSETS.fetch(request);
  },
};
```

Deploy it with `Cloudflare.Website.EffectUI` (or `Cloudflare.Website.Foldkit`), `main: "src/worker.ts"`, the server bound as `BANK`, and `assets: { runWorkerFirst: ["/api", "/api/*"] }`.

More: [Sessions](https://alchemy.run/domain/sessions), [Cloudflare: Effect UI](https://alchemy.run/cloudflare/frontend/effect-ui).

## Trace the browser

Effect UI and Foldkit both run every Command in a span, and Api calls carry the trace to the server, live reads too. Give the app an OTLP tracer that exports to its own origin, and collect the spans in the server Worker with `Telemetry.relay`, which forwards them with the server's credentials. Never put an ingest token in the browser.

More: [Observability: Trace the browser](https://alchemy.run/domain/observability#trace-the-browser).

## Show writes before they're confirmed

Show a write as pending under the `commandId` the app made for it, and confirm it when the view event carrying that id arrives; a typed rejection marks it rejected. Show the server's balance plus every unacknowledged line, so nothing is ever rolled back. With Effect UI, a value in a query or View entry needs only an `optimistic` patch.

Offline, record what the user asked for, never facts the server owns. Queue sends that can't reach the server in order, persist them to `localStorage`, and deliver them with their ids when back online; the server applies each id once. A conflict is just a typed rejection.

`MyAggregate.predict(state, command, { now, context })` runs the aggregate's own `decide` and `evolve` and returns `Accepted`, `Rejected` or `Unpredictable`; `MyView.evolve` folds a predicted event like the server's view. Still confirm from the stream. A local mirror of server aggregates isn't supported: it needs a sync engine or CRDTs.

More: [Optimistic updates](https://alchemy.run/domain/optimistic-updates), [Offline and local first](https://alchemy.run/domain/local-first).

## Show AI agent sessions

An app whose pages show AI agent sessions records them into the model first: see the `alchemy-ai` skill's `references/front-end.md`.

More: [Connect a front end](https://alchemy.run/ai/front-end).
