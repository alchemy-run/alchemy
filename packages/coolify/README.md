# @alchemy.run/coolify

[Coolify](https://coolify.io) for [Alchemy](https://alchemy.run). Declare projects, environments, applications and databases on your self-hosted Coolify (or Coolify Cloud) next to the rest of your stack.

```sh
npm install alchemy @alchemy.run/coolify effect
```

An image behind Coolify's proxy, connected to a Postgres on the same server:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Coolify from "@alchemy.run/coolify";
import * as Effect from "effect/Effect";

const server = "<server-uuid>"; // Servers → your server → the UUID in the URL

export default Alchemy.Stack(
  "Shop",
  {
    providers: Coolify.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Coolify.Project("shop", {});

    const db = yield* Coolify.Database.Postgres("db", {
      project: project.projectUuid,
      environmentName: "production",
      server,
    });

    const api = yield* Coolify.Application("api", {
      project: project.projectUuid,
      environmentName: "production",
      server,
      image: "ghcr.io/acme/api:1.4.2",
      ports: [3000],
      env: { DATABASE_URL: db.internalUrl },
    });

    return { url: api.url };
  }),
);
```

Authenticate with an API token from **Keys & Tokens → API tokens** with `read`, `write`, `deploy` and `delete` (destroy needs `delete`), plus `read:sensitive` to read database URLs back. A token limited to selected projects can't create projects: use `Coolify.Project.lookup` for its project.

```sh
export COOLIFY_TOKEN=...
export COOLIFY_API_BASE_URL=https://coolify.example.com
```

See the [Coolify provider docs](https://alchemy.run/providers/coolify/reference/project) for every resource.
