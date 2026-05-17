# Prisma Next.js

A complete Next.js example for Alchemy's Prisma provider. The stack provisions:

- a Prisma project
- a `main` Prisma branch
- a Prisma Postgres database via `Prisma.Postgres(...)`
- a database connection with redacted connection strings
- a standalone Prisma environment variable for shared project config
- a Next.js app deployed to Prisma Compute with `ComputeApp build: "auto"`

## Files

- `alchemy.run.ts` is the infrastructure program.
- `next.config.mjs` enables `output: "standalone"` for Prisma Compute upload.
- `src/app/page.tsx` reads runtime env from Prisma Compute.
- `src/app/api/health/route.ts` exposes a secret-safe health endpoint.

The example intentionally shows both env patterns:

- `Prisma.EnvironmentVariable(...)` for shared project-level config.
- `ComputeApp.env` for deployment-specific values like connection strings and
  app flags.

## Local Dev

Local dev does not need Prisma credentials. `alchemy dev` starts a local
Prisma Postgres with `@prisma/dev`, passes its redacted pooled/direct URLs into
the same `ComputeApp.env` keys used by deploy, and then runs the Next.js dev
server from `ComputeApp.dev.command`.

```sh
bun install
bun run dev
```

Open `http://localhost:3000`.

If port 3000 is busy:

```sh
PRISMA_NEXTJS_DEV_PORT=3010 bun run dev
```

## Deploy

Deployment needs Prisma credentials because it creates real Prisma resources.

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run deploy
```

You can also configure stored credentials:

```sh
alchemy login --configure
bun run deploy
```

`ComputeApp build: "auto"` detects Next.js, runs `next build`, uploads the
`.next/standalone` server, copies `public` and `.next/static`, starts a Compute
version, promotes it, and returns the service URL.

## Destroy

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run destroy
```

Known platform blocker from live smoke testing: Prisma Compute currently returns
HTTP 500 for deleting a stopped Compute version in the tested environment. If
that happens, Alchemy has already attempted the documented stop/delete flow; see
`../../PRISMA_COMPUTE_PLATFORM_BUGS.md` for the stranded IDs and repro.

## Why `Prisma.Postgres`?

`Prisma.Postgres` is a convenience alias for `Prisma.Database`. It makes app
code read like the product name while keeping one underlying reconciler:

```typescript
const postgres = yield* Prisma.Postgres("Postgres", {
  project,
  name: "main",
  region: "us-east-1",
});
```

Use `Prisma.Database` when you want to mirror the Management API naming exactly.
