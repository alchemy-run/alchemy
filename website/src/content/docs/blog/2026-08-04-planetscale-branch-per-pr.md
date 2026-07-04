---
title: A database branch for every pull request
date: 2026-08-04
draft: true
excerpt: PR stages fork a copy-on-write branch off your long-lived PlanetScale database, run migrations against it, and serve the preview from an isolated schema. Close the PR and the branch, credential, and compute disappear — the shared database untouched.
---

<!-- VIDEO EMBED: planetscale-branch-per-pr -->

Two deploys of the same program, two stage flags:

```sh
bun alchemy deploy --stage staging
# → app-db          Planetscale.PostgresDatabase      created
# → app-branch      Planetscale.PostgresBranch        created
# → app-role        Planetscale.PostgresRole          created
# → app-hyperdrive  Cloudflare.Hyperdrive.Connection  created
# → Api             Cloudflare.Worker                 created

bun alchemy deploy --stage pr-147
# → app-db          resolved as a reference to staging's state — no API call
# → app-branch      Planetscale.PostgresBranch        created
# → app-role        Planetscale.PostgresRole          created
# → app-hyperdrive  Cloudflare.Hyperdrive.Connection  created
# → Api             Cloudflare.Worker                 created
```

`staging` owns the long-lived database. `pr-147` forks a
copy-on-write **branch** off it — plus a credential scoped to
that branch, a Hyperdrive in front, and a Worker — and serves
the preview from a fully isolated schema. It's a branch per PR
off a shared database: the expensive tier is created once and
shared; every preview owns only the cheap, ephemeral pieces.

The whole split is one conditional in the stack.

## One conditional, two worlds

The deciding input is the stage, which the `Stack` service
exposes to every stack effect — `stage` is whatever was passed
to `alchemy deploy --stage <name>`:

```typescript
import * as Alchemy from "alchemy";
import * as Planetscale from "alchemy/Planetscale";

const { stage } = yield* Alchemy.Stack;

const database = stage.startsWith("pr-")
  ? yield* Planetscale.PostgresDatabase.ref("app-db", { stage: "staging" })
  : yield* Planetscale.PostgresDatabase("app-db", {
      region: { slug: "us-east" },
      clusterSize: "PS_10",
    });
```

`Resource.ref(id, { stage })` reads the deployed resource's
attributes from another stage's state at plan time. The lookup
is keyed by `{ stack, stage, id }`, so the logical ID `"app-db"`
must match what `staging` created. `database` is typed
`Planetscale.PostgresDatabase` on both paths — downstream
resources don't know or care which one ran.

Below the conditional, nothing is conditional. Every stage —
including each PR stage — forks its own branch and mints its own
credential:

```typescript
const branch = yield* Planetscale.PostgresBranch("app-branch", {
  database,
  migrationsDir: "./migrations",
});

const role = yield* Planetscale.PostgresRole("app-role", {
  database,
  branch,
  inheritedRoles: ["postgres"],
});
```

Branches fork from `main` by default and are copy-on-write, so
each preview gets its own schema and its own writes without
provisioning a cluster per PR. To fork data as well as schema,
`seedData: "last_successful_backup"` restores the last backup
into the new branch.

One ordering rule: a ref can only resolve against state that
exists, so `staging` deploys before the first `pr-*` stage. Get
it backwards and the plan fails with `InvalidReferenceError` —
at plan time, before anything is created.

The full walkthrough (including a variant that gives each PR its
own database owner by targeting a parallel `staging-pr-N` stage)
is in
[Branch from a shared database](/cloudflare/data/branch-from-shared-database)
and the
[preview branches guide](/planetscale/guides/preview-branches).
The MySQL (Vitess) family has the same shape —
`MySQLDatabase.ref`, `MySQLBranch`, `MySQLPassword` — see
[MySQL](/planetscale/data/mysql).

## Migrations as a plan diff

`migrationsDir` makes migrations part of the deploy itself:
pending `.sql` files are applied to the branch on every deploy,
in order, over a credential alchemy mints for the run and
deletes afterwards (10-minute TTL either way). Pairing the
branch with a `Drizzle.Schema` resource closes the loop — the
schema resource regenerates pending SQL from your TypeScript
schema, and the branch applies whatever is new:

```typescript
const schema = yield* Drizzle.Schema("app-schema", {
  schema: "./src/schema.ts",
  out: "./migrations",
});

const branch = yield* Planetscale.PostgresBranch("app-branch", {
  database,
  migrationsDir: schema.out,
});
```

Each file is SHA-256 hashed into the resource's state, and
applied files are recorded in an `__alchemy_migrations` table —
one row per file. So the loop behaves like any other resource
diff:

- Drop `0002_posts.sql` into the directory and redeploy: the
  branch resource is marked for update, the file runs inside a
  transaction, and a tracking row lands.
- Redeploy with nothing new: hashes match, the migration step is
  skipped — the deploy is a no-op.

Ordering, hashing, the tracking table, engine differences, and
seed files are covered in
[Migrations](/planetscale/data/migrations).

## Wiring it to the Worker

The per-stage credential is what connects compute. `role.origin`
plugs straight into a Hyperdrive connection, and the Worker
reaches the branch through it:

```typescript
export const Hyperdrive = Effect.gen(function* () {
  const { role } = yield* PlanetscaleDb;
  return yield* Cloudflare.Hyperdrive.Connection("app-hyperdrive", {
    origin: role.origin,
    caching: { disabled: true },
  });
});
```

```typescript
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.postgres(conn.connectionString, { relations });

    return {
      fetch: Effect.gen(function* () {
        const users = yield* db.select().from(Users);
        return yield* HttpServerResponse.json({ users });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
```

Because every stage runs the same program, `pr-147`'s Worker is
wired to `pr-147`'s Hyperdrive, which points at `pr-147`'s
branch, authenticated by `pr-147`'s role. Write a row through
the preview and query `staging`: the row is only in the branch.

Both engines ship as complete working projects:
[`cloudflare-planetscale-postgres-drizzle`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-postgres-drizzle)
and
[`cloudflare-planetscale-mysql-drizzle`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-mysql-drizzle).

## Destroy cannot reach the shared database

```sh
bun alchemy destroy --stage pr-147
```

Destroy removes what the stage owns: the branch, the role, the
Hyperdrive, the Worker. The referenced database stays — and
that's structural, not a convention. A `.ref` resource was read
from another stage's state; this stage never owned it, so the
engine has nothing to delete. `staging` keeps its database, its
data, and every other PR branch forked off it.

That property is what makes preview environments safe to include
the database layer: the teardown that runs on every PR close is
scoped, by ownership, to the ephemeral tier. Details in
[Branch from a shared database](/cloudflare/data/branch-from-shared-database).

## Where to go next

- [Preview branches per PR](/planetscale/guides/preview-branches)
  — the guide this post condenses, for both engines.
- [Migrations](/planetscale/data/migrations) — ordering, hashing,
  the tracking table, seed data.
- [Branch from a shared database](/cloudflare/data/branch-from-shared-database)
  — the full walkthrough with a Cloudflare Worker on the other
  end.
- [`cloudflare-planetscale-postgres-drizzle`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-postgres-drizzle)
  and
  [`cloudflare-planetscale-mysql-drizzle`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-mysql-drizzle)
  — the complete example apps.

Next week this feeds directly into the finale: a GitHub Actions
workflow that deploys a `pr-N` stage when a PR opens — database
branch included — and destroys it when the PR closes.

Alchemy is in beta:

```sh
bun add alchemy@next
```
