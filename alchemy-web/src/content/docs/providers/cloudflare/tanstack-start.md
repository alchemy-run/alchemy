---
title: TanStackStart
description: Learn how to deploy TanStack Start applications to Cloudflare Workers using Alchemy for modern web development.
---

Deploy a TanStack Start application to Cloudflare Pages with automatically configured defaults.

## Minimal Example

```ts
import { TanStackStart } from "alchemy/cloudflare";

const app = await TanStackStart("my-app");
```

## With Custom Build Command

```ts
import { TanStackStart } from "alchemy/cloudflare";

const app = await TanStackStart("my-app", {
  command: "bun run test && bun run build:production",
});
```

## With Database Binding

```ts
import { TanStackStart, D1Database } from "alchemy/cloudflare";

const database = await D1Database("my-db", {
  name: "my-db",
});

const app = await TanStackStart("my-app", {
  bindings: {
    DB: database,
  },
});
```

## With Environment Variables

```ts
import { TanStackStart } from "alchemy/cloudflare";

const app = await TanStackStart("my-app", {
  bindings: {
    API_KEY: alchemy.secret(process.env.API_KEY),
  },
  vars: {
    NODE_ENV: "production",
    APP_ENV: "staging",
  },
});
```

## Bind to a Worker

```ts
import { Worker, TanStackStart } from "alchemy/cloudflare";

const app = await TanStackStart("my-app");

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    APP: app,
  },
});
```

## With Transform Hook

Customize the generated wrangler.json configuration for your TanStack Start application:

```ts
import { TanStackStart } from "alchemy/cloudflare";

const app = await TanStackStart("my-app", {
  command: "bun run build",
  transform: {
    wrangler: (spec) => ({
      ...spec,
      // Add TanStack Start-specific compatibility flags
      compatibility_flags: ["nodejs_compat", "experimental"],
      // Override the main entry point
      main: "dist/server.js",
      // Add custom environment variables for TanStack Start
      vars: {
        ...spec.vars,
        TANSTACK_VERSION: "1.0.0",
        SSR_MODE: "streaming",
        ROUTER_MODE: "history",
      },
    }),
  },
});
```

The transform hook allows you to modify the wrangler.json configuration before deployment. This is particularly useful for TanStack Start applications to:

- Configure SSR-specific compatibility flags
- Customize router and build outputs
- Set environment variables for TanStack Start runtime
- Add custom routes for API endpoints and server functions
