# @alchemy.run/cloudflare-runtime

Cloudflare Workers runtime and build integrations for Alchemy.

- `@alchemy.run/cloudflare-runtime/core` — local Workers runtime
- `@alchemy.run/cloudflare-runtime/rolldown` — Rolldown plugin
- `@alchemy.run/cloudflare-runtime/vite` — Vite plugin

## Local Explorer (experimental)

Enable Local Explorer when starting local development:

```sh
CLOUDFLARE_RUNTIME_LOCAL_EXPLORER=true alchemy dev
```

Open `/cdn-cgi/local/explorer/` on any local Worker. Direct runtime callers can
set `RuntimeWorker.localExplorer: true`; `false` overrides the environment flag.
The feature is disabled by default and has no effect on deployed Workers.
Each enabled Worker logs its direct Local Explorer URL once its runtime starts.
The URL uses the actual bound port; it is printed again when the runtime restarts.

- KV: namespaces, key pagination/prefixes, values, metadata, expiration, and create/update/delete.
- SQLite Durable Objects: persisted instances, table browsing, and SQL queries.
- D1: table browsing and SQL queries.
- R2: object browsing, metadata, downloads, uploads, and deletion.
- Workflows: instance status and step history; create, pause, resume, restart,
  terminate, send events, and delete individual/batches/all instances.
- Email: sent and received messages, bodies and attachment metadata, simulated
  incoming delivery, and captured rejection/forward/reply results.

Workers sharing the same local storage directory discover each other through
Alchemy's dev registry. Queries go to the Worker that owns the resource.
Durable Object SQL runs through the live object, retaining its namespace key and
storage location. Names first observed while inspection is enabled are persisted
using Miniflare's internal `__miniflare_do_name` table; older objects may appear by
ID until accessed by name. Listing persisted objects can activate their constructors.

D1 and Durable Object SQL consoles and resource controls can modify local data.
Workflow deletion stops execution and clears state through the live Engine;
empty SQLite files may remain on disk and are excluded from instance listings.
Legacy Durable Object namespaces can be listed, but
only SQLite objects support SQL inspection; ephemeral objects are omitted.
Opt in to persisted traces and events separately with
`CLOUDFLARE_RUNTIME_LOCAL_EXPLORER_OBSERVABILITY=true` alongside the Explorer flag.
Workers sharing local storage forward to a single leased collector process, which
can be replaced when its owning runtime exits. SQL queries are read-only; the
clear-history action clears traces/logs for that shared storage directory.

Email capture uses a persistent store per Worker and aggregates through the same
registry. Local `send_email` bindings retain their sender/recipient restrictions;
remote bindings are not intercepted. Incoming test emails can be sent through
Explorer or `/cdn-cgi/handler/email` (`/cdn-cgi/local/email` is also accepted).
Delivery, forwarding, and replies are simulated locally. Messages saved before
capture was enabled remain on disk but are not backfilled into Explorer. Capture
size limits and truncation indicators follow the pinned Miniflare implementation.
Queues, cron controls, and JavaScript inspection are not included.
Telemetry is disabled.

The Explorer assets and Durable Object wrapper use the pinned Miniflare package;
upgrading it requires rerunning the runtime Explorer integration tests.

## Upstream references

- Cloudflare Workers SDK: [`b7b4ff84477982e7c770bb93928287893fcf2e03`](https://github.com/cloudflare/workers-sdk/tree/b7b4ff84477982e7c770bb93928287893fcf2e03)
