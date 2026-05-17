# Prisma Compute

Deploy a small Bun HTTP service to Prisma Compute with Alchemy.

## What Alchemy Owns

The Prisma provider has two layers:

- Lifecycle resources for things Alchemy can safely deploy and destroy:
  `Project`, `Database`, `Connection`, `Branch`, `ComputeService`,
  `ComputeVersion`, `EnvironmentVariable`, `SourceRepository`, and
  `ComputeApp`.
- Operation helpers for the full Prisma Management API surface, including
  workspaces, regions, project transfer, backups, restore, database usage,
  integrations, logs, and source repositories.

`ComputeApp` is the Worker-like path: in deploy mode it creates or updates a
compute service, builds/uploads a version, starts it, promotes it, tails logs,
and destroys the service/version state owned by the stack. In dev mode it runs
a local command and returns a localhost URL without requiring Prisma cloud
credentials.

For direct Management API helpers outside a stack resource lifecycle, provide
`Prisma.managementApi()`:

```typescript
const projects = yield* Prisma.listProjects().pipe(
  Effect.provide(Prisma.managementApi()),
);
```

For app builds, you can choose either explicit IaC-style commands or
Prisma Compute-style auto-build detection:

- `build: { command, outdir, entrypoint }` for deterministic build steps.
- `build: "auto"` for Next.js, Nuxt, Astro, TanStack Start, or Bun detection.
- `artifactPath` for a pre-created `tar.gz` artifact.

The user-facing stack is just normal Alchemy code:

```typescript
const project = yield* Prisma.Project("Project", {
  name: "my-api-project",
  createDatabase: false,
});

const app = yield* Prisma.ComputeApp("App", {
  project: project.projectId,
  serviceName: "my-api",
  path: ".",
  build: {
    command: "bun build src/server.ts --target bun --outdir dist",
    outdir: "dist",
    entrypoint: "server.js",
  },
  dev: {
    command: "bun run dev:server",
    port: 8787,
  },
  destroyOldVersion: true,
});
```

Prisma Postgres can be written with the product-shaped alias
`Prisma.Postgres(...)`, which uses the same underlying provider as
`Prisma.Database(...)`:

```typescript
const postgres = yield* Prisma.Postgres("Database", {
  project,
  name: "main",
  region: "us-east-1",
});

const connection = yield* Prisma.Connection("Connection", {
  database: postgres,
  name: "api",
});
```

Runtime environment variables passed through `ComputeApp.env` are reconciled
through Prisma's environment variable API. Removing a key from `env` deletes the
old Prisma variable, and `alchemy destroy` removes the env vars managed by the
app before deleting compute versions and the service.

Auto-build is useful when you want SDK-like ergonomics:

```typescript
const app = yield* Prisma.ComputeApp("App", {
  project: project.projectId,
  serviceName: "my-web",
  path: "./apps/web",
  build: "auto",
  destroyOldVersion: true,
});
```

Alchemy tries the same broad strategy order as the Prisma Compute SDK: Next.js,
Nuxt, Astro, TanStack Start, then Bun. For a specific strategy, use
`build: { type: "auto", framework: "nextjs" }`.

## Local Dev

```sh
bun install
bun run dev
```

`alchemy dev` starts `bun run dev:server` through `Prisma.ComputeApp.dev` and
does not require a Prisma token.

## Deploy

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run deploy
```

`PRISMA_API_TOKEN` also works, matching the Prisma Compute CLI. For a
non-default Prisma Management API endpoint, set `PRISMA_API_URL` or
`PRISMA_MANAGEMENT_API_URL`.

You can also store the token in an Alchemy profile:

```sh
alchemy login --configure
bun run deploy
```

The stack creates a Prisma project, creates or updates a compute service,
bundles `src/server.ts` into `dist/server.js`, uploads the built artifact,
starts a compute version, promotes it, and prints the URL.

If you already have a `tar.gz` artifact, use `artifactPath` instead of `path` and
`build`:

```typescript
const app = yield* Prisma.ComputeApp("App", {
  project: project.projectId,
  serviceName: "my-api",
  artifactPath: "./dist/app.tar.gz",
  port: 8080,
});
```

## Logs And Destroy

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run tail
bun run destroy
```

Prisma Compute exposes logs as a streaming WebSocket, so this example uses
`alchemy tail` for live logs.

`destroyOldVersion: true` removes the previously promoted version after a
successful promotion. `bun run destroy` removes the service and project state
managed by this stack.

Known Prisma Compute platform issue found during smoke testing: deleting a
stopped compute version can currently return HTTP 500, which prevents service
and project cleanup. If that happens, the Alchemy stack has already issued the
documented stop/delete flow; capture the failing version ID from the error and
retry cleanup after the platform-side fix. Details are in
`../../PRISMA_COMPUTE_PLATFORM_BUGS.md`.

For an already-stranded live smoke resource, set the IDs from the failure and
run the cleanup-only test after the platform fix:

```sh
export PRISMA_SERVICE_TOKEN="..."
export PRISMA_CLEANUP_PROJECT_ID="proj_..."
export PRISMA_CLEANUP_COMPUTE_SERVICE_ID="cps_..." # optional final check
export PRISMA_CLEANUP_COMPUTE_VERSION_ID="cpv_..." # optional direct retry
bun run cleanup:live
```

If you want cleanup to use a stored Alchemy profile instead of env vars, first
run `alchemy login --configure` and select `Service Token`, then set the cleanup
IDs and run:

```sh
bun run cleanup:live:profile
```

If the active profile is configured for environment variables, cleanup still
needs `PRISMA_SERVICE_TOKEN` or `PRISMA_API_TOKEN`.

## Live Test

The repository smoke test deploys this same shape, fetches the deployed URL,
and attempts to destroy the stack afterward. The test is intentionally skipped
unless `ALCHEMY_RUN_LIVE_PRISMA_TESTS=true` is set because it creates real
Prisma Compute resources and currently depends on the upstream destroy fix.

```sh
export PRISMA_SERVICE_TOKEN="..."
bun run test:live
```

If you configured stored Prisma credentials with `alchemy login --configure`
and selected `Service Token`, use:

```sh
bun run test:live:profile
```

If an existing profile is configured for environment variables, re-run
`alchemy login --configure` and select `Service Token` to switch that profile to
stored credentials.
