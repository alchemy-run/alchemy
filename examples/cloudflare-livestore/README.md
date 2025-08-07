# Cloudflare Livestore Example

This example shows how to use Cloudflare Livestore with Alchemy.

## Getting Started

```bash
bun install
bun dev # run locally 
bun run deploy # or deploy to Cloudflare
```

## Cloudflare Infrastructure

See the [alchemy.run.ts](./alchemy.run.ts) file for the infrastructure configuration.

## Livestore Runtime 

See the [src/livestore](./src/livestore) directory for the livestore code:
1. [worker.ts](./src/livestore/worker.ts) - The client-side worker that syncs data to/from the server.
2. [server.ts](./src/livestore/server.ts) - The server-side Cloudflare worker code that handles the data synchronization and web socket connections.
3. [events.ts](./src/livestore/events.ts) - The events definitions for the livestore.
4. [tables.ts](./src/livestore/tables.ts) - The SQLite table definitions for the livestore.
5. [queries.ts](./src/livestore/queries.ts) - The SQLite query definitions for the livestore.
6. [materializers.ts](./src/livestore/materializers.ts) - The event-sourced materializers for the livestore.

## SvelteKit Runtime

See the [src/app](./src/app) directory for the SvelteKit code:
1. [routes/index.svelte](./src/app/routes/index.svelte) - The main page for the SvelteKit app.
