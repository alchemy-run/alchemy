# AWS Vite Example

A React + Vite SPA with an effect-native backend, deployed as ONE
`AWS.Website.StaticSite`:

- the Vite build uploads to a private S3 bucket behind CloudFront
- the Effect program in `src/backend.ts` deploys as an effect Lambda that
  the CloudFront edge router consults FIRST for `/api/*` — a static file
  can never shadow an API path, even with `spa: true`
- the program binds S3 (visits counter) and SQS (jobs queue), and
  registers the queue CONSUMER on the same Lambda with
  `SQS.consumeQueueMessages`

## The API surface

The SPA has no server functions, so the public API is an effect `HttpApi`
schema:

- `src/api.ts` — the shared schema module: endpoints, payloads, and
  responses as `Schema` values. No backend imports; browser-safe.
- `src/backend.ts` — mounts the schema with `HttpApiBuilder.group` on the
  site's `fetch` handler. Payload validation runs before any handler (an
  empty queue message is a 400).
- `src/lib/client.ts` — the browser client via `HttpApiClient.make`,
  importing ONLY the schema. Zero server bytes in the bundle.

The backend's non-`fetch` methods (`visits`, `bump`, `enqueue`,
`processed`) remain the trusted-caller RPC surface — callable in-process
via `createClient(Site)` from server-side code or from sibling functions
over invoke bindings. They are not exposed over HTTP.

## UI

React + Tailwind with minimal shadcn-style components
(`src/components/ui/`): a visits card with an optimistic bump, and a queue
card that enqueues a message and polls `/api/queue/processed` until the
consumer catches up.

## Commands

```sh
bun install
bun run --filter aws-vite-example deploy
```

For local development:

```sh
bun run --filter aws-vite-example dev        # alchemy dev: Vite + local Lambda emulator
bun run --filter aws-vite-example dev:vite   # frontend-only iteration
```

Under `alchemy dev`, Vite serves the frontend and the backend runs in the
local Lambda emulator at the stack's `serverUrl` output. Set
`VITE_API_PROXY=<serverUrl>` to proxy the Vite dev server's `/api/*` to
it. The DynamoDB table is `remote()` (real AWS); queue delivery engages on
deploy — `alchemy dev` does not dispatch queue events locally.

## Optional Custom Domain

Set these environment variables before deploy:

```sh
export WEBSITE_DOMAIN=app.example.com
export WEBSITE_ZONE_ID=Z1234567890
export WEBSITE_ALIASES=www.app.example.com
```

Without them, the example still deploys and returns the CloudFront URL.
