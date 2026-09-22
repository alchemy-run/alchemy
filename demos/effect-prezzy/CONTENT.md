# Content plan: building "Shorty" with Alchemy

One app, built live from an empty folder: a link shortener with link
previews and live click analytics. Every feature is added because the app
needs it, and each step introduces one Alchemy or Effect idea.

The talk is about Effect on Cloudflare: Workers, Durable Objects, event
sources, sinks and Layers. The Vite website comes last as a dashboard.

## The app

```
browser ─► Api Worker (Effect)
            ├─ POST /links ──────► Links service (Layer: KV → DynamoDB)
            │        └──────────► Jobs Queue ─► unfurl job (fetch title, retry)
            ├─ POST /links/import ─ Stream ─► QueueSink(Jobs)
            ├─ GET /:code ───────► 302 + click event ─► Clicks Queue
            │                        Clicks consumer (Stream, grouped) ─► LinkRoom DO
            ├─ GET /links/:code/live ── WebSocket ─► LinkRoom DO (hibernatable)
            └─ cron hourly ──────► stale previews ─ Stream ─► QueueSink(Jobs)
Dashboard (Website.Vite) ─► HttpApi typed client + live WebSockets
```

| Need in the app | Alchemy / Effect feature |
| --- | --- |
| Serve an HTTP API | Worker, Effectful Constructor, phases |
| Store links | Resource + Binding (KV) |
| Hide storage behind a service | Layer that owns its infrastructure |
| Read-after-write links (KV is eventually consistent) | Swap the Layer to DynamoDB (cross-cloud) |
| Fetch page titles without blocking the request | Queue producer + `consumeQueueMessages` (background job) |
| Import many links at once | `QueueSink`: Stream → Sink with batching |
| Count clicks without slowing redirects | Clicks Queue as an event source, processed as a Stream |
| Live click counts per link | Durable Object, storage, hibernatable WebSockets |
| Refresh stale previews | Cron event source feeding the same sink |
| A typed public API | Effect `HttpApi` + derived client |
| A UI | `Cloudflare.Website.Vite` |

## Act 0: Why Alchemy (slides)

1. **Title.**
2. **Infrastructure as Code, in Effect.** The one-file R2 Bucket + Worker
   from *What is Alchemy*, beside the traditional two-file version
   (`env.Uploads` + a separate handler).
3. **What we'll build.** The architecture diagram above.

## Act 1: A Stack and a Worker

4. **Hello, Worker.** Editor: `alchemy.run.ts` (Stack, providers, state)
   and `src/Api.ts` whose constructor returns `fetch`. Terminal:
   `alchemy deploy` (plan, confirm, URL). Browser: "hello".
5. **Two phases** (slide). The outer Effect runs at deploy time and at
   cold start; `fetch` runs per request. `RuntimeContext` marks
   request-only code. Stages: `dev_$USER` vs `--stage prod`.

## Act 2: Bindings

6. **Store links in KV.** `Links = KV.Namespace("Links")` next to the
   Worker; `yield* Cloudflare.KV.ReadWriteNamespace(Links)`;
   `POST /links` returns a code, `GET /:code` redirects. Terminal: plan
   shows `+ Links`, `~ Api`; `curl` creates a link and follows the
   redirect. Point: the binding is the typed client; nothing is wired
   through `env` by hand.
7. **Errors are values.** `Effect.catchTag` on the KV error, a
   `LinkNotFound` tagged error returned as a 404, `Effect.retry` with a
   schedule.

## Act 3: Infrastructure as Layers

8. **A `Links` service.** `class Links extends Context.Service` with
   `create` / `get` / `list` / `setPreview`. `LinksKV` is a Layer that
   owns the namespace and its binding. The Worker becomes `yield* Links`
   + `Effect.provide(LinksKV)`. Terminal: deploy shows no changes, proving
   the refactor moved no infrastructure.
9. **The types hold the boundary.** Calling `links.get` in the outer
   Effect is a compile error (`RuntimeContext`); so is providing a
   Layer the host can't satisfy.

## Act 4: Background jobs with Queues

10. **Unfurl links in the background.** `POST /links` now enqueues
    `{ code, url }` on a `Jobs` Queue with `WriteQueue` and returns
    immediately. `consumeQueueMessages(Jobs, stream => …)` fetches the
    page with `HttpClient`, extracts the `<title>`, and saves the preview
    through `Links`. `Effect.timeout` + `Effect.retry`; a failing batch is
    redelivered and eventually dead-lettered. Terminal:
    `alchemy logs --tail` shows the job running after `curl` returns.
11. **Bulk import with a Sink.** `POST /links/import` takes many URLs:
    `Stream.fromIterable(urls).pipe(Stream.mapEffect(links.create),
    Stream.map(toJob), Stream.run(jobsSink))` with
    `yield* Cloudflare.Queues.QueueSink(Jobs)`. One `sendBatch` per chunk;
    `Stream.rechunk` controls batch size. Point: source → transform →
    sink is one expression.
12. **KV is eventually consistent.** The logs say the job stored the
    preview, but `GET /links/:code` still shows none, and a new link is
    missing from `GET /links` for up to a minute. (Seen on every real
    deploy while building the reference app.) Links need read-after-write
    consistency.
13. **Swap the Layer to DynamoDB.** `LinksDynamo` owns an
    `AWS.DynamoDB.Table` and binds `GetItem` (with `ConsistentRead`) /
    `PutItem` / `Scan`. One `Effect.provide` line changes; the Stack adds
    `AWS.providers()`. Terminal (`--profile testing`): the plan adds the
    table plus the IAM user, key and role the Worker assumes, and removes
    the KV namespace. Nothing else in the Worker changes. Browser: the
    preview now appears as soon as the job finishes.

## Act 5: Durable Objects and live clicks

14. **Count clicks off the hot path.** The redirect sends a click event to
    a `Clicks` Queue. The consumer receives each batch as a `Stream`,
    folds them into a count per link (`Stream.runFold`), and records one
    increment per link per batch.
15. **One Durable Object per link.** `LinkRoom` keeps its count in
    transactional storage and exposes typed RPC methods (`record(n)`,
    `clicks()`). The consumer calls `rooms.getByName(code).record(n)`.
    Point: RPC between Worker and Durable Object is typed with no schema.
16. **Live counts over hibernatable WebSockets.**
    `GET /links/:code/live` forwards to the room's `fetch`, which calls
    `Cloudflare.upgrade()`; `record` broadcasts the new count to
    `state.getWebSockets()`. Idle rooms hibernate and keep their sockets.
    Browser: a live counter; clicking the short link in another tab makes
    it tick.
17. **Refresh stale previews on a schedule.**
    `Cloudflare.Workers.cron("0 * * * *", …)` lists links whose preview
    is older than a day and runs them into the same `QueueSink(Jobs)`.
    Same pipeline, different trigger. Code + plan only.

## Act 6: Ship the API and the site

18. **A typed HTTP API.** Replace hand-written routing with an Effect
    `HttpApi` (`Link`, `LinkNotFound`, `createLink`, `getLink`,
    `listLinks`, `importLinks`). Same handlers, now schema-validated, with
    a client derived from the same value.
19. **The dashboard.** `Cloudflare.Website.Vite("Dashboard", { env: {
    VITE_API_URL: api.url } })`: a React page that lists links with
    previews, creates links through the typed client, and opens a live
    WebSocket per link. Browser finale: create a link, click it in
    another tab, watch the count and the preview appear.
20. **Recap** (slide): Stack → Runtime → Bindings → Layers → Queues
    (sources and sinks) → Durable Objects → API + Website, with doc links.
    `alchemy destroy` runs off camera.

## Reference app

`app/` is the finished app (the state after scene 19), built and
deployed against the `testing` account to prove the plan works end to
end. The scene-by-scene checkpoints will be cut from it.

| File | Scenes |
| --- | --- |
| `app/alchemy.run.ts` | Stack with the Api Worker and the Dashboard website |
| `app/src/Links.ts` | `Links` service contract, `LinkNotFound` (8, 18) |
| `app/src/LinksKV.ts` | KV-backed `Links` Layer (8) |
| `app/src/Queues.ts` | `Jobs` and `Clicks` queues and message types (10, 14) |
| `app/src/unfurl.ts` | Page-title fetch with timeout and retry (10) |
| `app/src/LinkRoom.ts` | Durable Object: count, RPC, WebSocket push (15, 16) |
| `app/src/ShortyApi.ts` | `HttpApi` schema shared with the dashboard (18) |
| `app/src/Api.ts` | Worker: consumers, cron, HttpApi, redirect, live route |
| `app/web/` | React dashboard with the typed client and live counts (19) |

Verified on a real deploy: creating and bulk-importing links, previews
filled in by the Jobs consumer, redirects, click counts arriving through
the Clicks queue into each `LinkRoom`, WebSocket pushes on every click,
the typed 404 from `HttpApi`, and the dashboard creating a link and
updating counts live.

Two scenes still use stand-ins until the product PRs land:

- Scene 13 keeps `LinksKV`; `LinksDynamo` needs DynamoDB bindings on
  Worker hosts.
- Scenes 11 and 17 send batches with `WriteQueue.sendBatch` inside
  `Stream.runForEachArray`; they switch to `Stream.run(QueueSink(Jobs))`.

## Product work this plan depends on

- `Cloudflare.Queues.QueueSink`: an Effect `Sink` over `sendBatch`
  (scenes 11, 17). In progress on its own PR.
- DynamoDB HTTP bindings on Cloudflare Worker hosts (scene 13). Today only
  S3 and Lambda invoke mint the cross-cloud identity. In progress on its
  own PR.
- Quieter `alchemy deploy` output: the Cloudflare Worker provider logs
  internal steps at Info level, which clutters every recorded deploy.

## Tooling this plan depends on

- Live browser capture (scenes 16, 19): record the page as video.
- A split terminal (scenes 10, 14): `alchemy logs --tail` beside `curl`.
- Editor diagnostics (scene 9): red squiggles captured from `tsc`.
- Slide layouts for code and diagrams (scenes 2, 3, 5, 20).
- Code checkpoints: each scene's end state lives as real files so every
  step type-checks and deploys on its own.
