# Prisma TanStack Start

Minimal TanStack Start app with Prisma Next queries, Prisma Postgres, and
Prisma Compute managed by Alchemy.

## What It Creates

- A Prisma project.
- A `main` Prisma branch.
- A Prisma Postgres database via `Prisma.Postgres(...)`.
- A database connection with redacted connection strings.
- A standalone Prisma environment variable for shared project config.
- A Prisma App.
- A single Deployment built from TanStack Start's `.output` artifact.
- Runtime env vars for database URLs, Prisma resource IDs, and app config.
- An optional Prisma App custom domain when `PRISMA_TANSTACK_DOMAIN` is set.
- A Prisma Next contract in `src/prisma/contract.prisma`.
- Generated Prisma Next artifacts in `src/prisma/contract.json` and
  `src/prisma/contract.d.ts`.
- A seed script that inserts demo users/posts and server routes that query them
  through `@prisma-next/postgres/runtime`.

The app uses an explicit Compute build command:

```sh
bun run db:setup && bun run build
```

`db:setup` emits the Prisma Next contract, initializes the database shape, and
seeds demo data before `vite build` writes the TanStack Start `.output` artifact.
The Deployment starts `server/index.mjs` on port `3000`.

## Local Dev

```sh
bun install
bun run dev
```

`alchemy dev` starts a local Prisma Postgres with `@prisma/dev`, passes the same
`DATABASE_URL`/`DIRECT_URL` env names used by deploy, runs `bun run db:setup`,
and then starts Vite with `bun run dev:start`.

Open `http://localhost:3000`.

If port 3000 is busy:

```sh
PRISMA_TANSTACK_DEV_PORT=3011 bun run dev
```

## Prisma Next Workflow

```sh
bun run emit      # regenerate contract.json + contract.d.ts
bun run db:init   # apply the contract to DATABASE_URL
bun run seed      # refresh the demo rows
bun run db:setup  # all of the above, in order
```

The Vite dev server also auto-emits the contract on edits. The explicit scripts
remain the source of truth for deploys and CI so builds are reproducible.

The runtime uses `pg`, so the example uses `Prisma.connectionEnv(connection)`
to pass the pooled `postgres://` endpoint as `DATABASE_URL` and the canonical
direct endpoint as `DIRECT_URL`. `POOLED_DATABASE_URL` explicitly exposes the
same pooled endpoint for libraries that prefer that conventional name. During
the build, `DATABASE_URL` is deliberately overridden with `DIRECT_URL` so
contract application and seeding never run through the pooled endpoint.

## Deploy

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run deploy
```

`PRISMA_API_TOKEN` also works. The deploy output prints the Compute URL.

To attach a custom domain during deploy, set:

```sh
export PRISMA_TANSTACK_DOMAIN="app.example.com"
bun run deploy
```

The stack output includes the custom domain status and DNS records to configure.

## Check It

```sh
curl "$URL/"
curl "$URL/api/health"
```

The health response should include:

```json
{
  "ok": true,
  "counts": {
    "users": 2,
    "posts": 3
  }
}
```

## Destroy

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run destroy
```
