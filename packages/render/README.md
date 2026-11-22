# @alchemy.run/render

Render infrastructure provider for [Alchemy](https://alchemy.run) — compute services, Workflows, Blueprints, preview environments, managed Postgres with SQL migrations and PgBouncer pooling, Key Value / Redis, projects, config groups, networking, observability streams, log tailing, and typed runtime bindings.

```sh
pnpm add alchemy @alchemy.run/render effect
# Optional: required when running Postgres SQL migrations or SQL seed imports
pnpm add pg @effect/sql-pg
```

## Authentication

Configure Render credentials using `alchemy profile edit --add Render`, or set environment variables (automatically used in `CI=true`):

- `RENDER_API_KEY` (or `RENDER_TOKEN`): Render REST API key
- `RENDER_OWNER_ID` (optional): workspace or user owner ID (`tea-...` / `usr-...`); auto-resolved when a single owner exists on `/owners`
- `RENDER_API_BASE_URL` (optional): overrides `https://api.render.com/v1`

## Quick start

Provision a project environment, Postgres database (with PgBouncer pooling, migrations, and SQL imports), Key Value store, and Web Service together:

```typescript
import * as Alchemy from "alchemy";
import * as Render from "@alchemy.run/render";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Render.providers(),
  },
  Effect.gen(function* () {
    const project = yield* Render.Project("App", {
      name: "my-app",
    });

    const db = yield* Render.Postgres("Database", {
      environmentId: project.environments.production.id,
      plan: "basic_256mb",
      region: "oregon",
      connectionPool: "pgbouncer",
      migrations: "./migrations",
      importFiles: ["./seed.sql"],
    });

    const cache = yield* Render.KeyValue("Cache", {
      environmentId: project.environments.production.id,
      plan: "starter",
      region: "oregon",
    });

    const api = yield* Render.WebService("Api", {
      environmentId: project.environments.production.id,
      plan: "starter",
      region: "oregon",
      healthCheckPath: "/health",
      runtimeSource: {
        image: { imagePath: "ghcr.io/org/api", tag: "latest" },
      },
      envVars: {
        DATABASE_URL: db.connectionInfo.internalConnectionString,
        REDIS_URL: cache.connectionInfo.internalConnectionString,
      },
    });

    return {
      apiUrl: api.url,
      dbId: db.id,
      pooledOrigin: db.pooledOrigin,
      cacheId: cache.id,
    };
  }),
);
```

## Resources

- **Compute & Workflows:** `WebService` (custom domains, DNS verification, edge `cacheProfile`, `purgeServiceCache`), `PrivateService`, `BackgroundWorker`, `CronJob`, `StaticSite`, `ServicePreview`, `Workflow`, and `Blueprint` (`validateBlueprint`)
- **Storage & Databases:** `Postgres` (PgBouncer `connectionPool`, `origin` / `pooledOrigin`, PITR `restoreFrom`, `readReplicas`, SQL `migrations`, `importFiles`, `createPostgresExport` / `listPostgresExports`), `KeyValue`, and `Redis`
- **Organization & Config:** `Project`, `Environment`, `EnvGroup`, `EnvGroupLink`, `RegistryCredential`
- **Networking & Observability:** `DedicatedIp`, `Webhook`, `LogStream`, `MetricsStream`, `NotificationSetting`

All resources include crash-recovery `read` lookups with `Unowned` conflict protection, `deleteFirst` replacement guards on duplicate names, runtime Effect Schema validation on Render API responses (`RenderSchemaError`), and `alchemy logs` / `alchemy logs --tail` across all 10 log-producing resources (`WebService`, `PrivateService`, `BackgroundWorker`, `CronJob`, `StaticSite`, `ServicePreview`, `Workflow`, `Postgres`, `KeyValue`, `Redis`). `WebService` and `PrivateService` also support `observe`/`precreate` for breaking mutual runtime binding cycles.

## Runtime bindings

Inject typed service, database, workflow, and Key Value access into runtimes (both Render services and foreign Alchemy `RuntimeContext` hosts):

- `ConnectPostgres` / `ConnectPostgresHttp` — binds `DATABASE_URL` and per-database internal, external, and PgBouncer pooled connection strings
- `ConnectService` / `ConnectServiceHttp` — binds `WebService`, `PrivateService`, `StaticSite`, or `ServicePreview` URLs with a normalized Effect `HttpClient` helper
- `RunWorkflowTask` / `RunWorkflowTaskHttp` — binds a `Workflow` slug and exposes `.trigger()`, `.getRun()`, `.cancelRun()`, and `.runAndWait()` over `/v1/task-runs`
- `ReadKeyValue`, `WriteKeyValue`, `ReadWriteKeyValue` (`*Http`) — scoped Redis/Valkey clients backed by `@alchemy.run/redis`

## Learn more

- [Render on alchemy.run](https://alchemy.run/render)
- [Setup](https://alchemy.run/render/setup)
- [API reference](https://alchemy.run/providers/render)
