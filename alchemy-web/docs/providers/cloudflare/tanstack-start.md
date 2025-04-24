# TanStackStart

Deploy a TanStack application to Cloudflare Pages with automatically configured defaults for the TanStack framework.

# Minimal Example

Create a basic TanStack site with default settings:

```ts
import { TanStackStart } from "alchemy/cloudflare";

const site = await TanStackStart("my-tanstack-app");
```

# With Custom Bindings

Add database and other bindings to your TanStack application:

```ts
import { TanStackStart, D1Database } from "alchemy/cloudflare";

const database = await D1Database("my-db", {
  name: "my-db"
});

const site = await TanStackStart("my-tanstack-app", {
  bindings: {
    DB: database,
    API_KEY: alchemy.secret(process.env.API_KEY)
  }
});
```

# With Custom Build Command

Customize the build command and environment variables:

```ts
import { TanStackStart } from "alchemy/cloudflare";

const site = await TanStackStart("my-tanstack-app", {
  command: "npm run test && npm run build:production",
  bindings: {
    API_KEY: alchemy.secret(process.env.API_KEY)
  },
  vars: {
    NODE_ENV: "production",
    APP_ENV: "staging"
  }
});
```

# Bind to a Worker

Use the TanStack site as a binding in another worker:

```ts
import { Worker, TanStackStart } from "alchemy/cloudflare";

const site = await TanStackStart("my-tanstack-app", {
  // ...
});

await Worker("my-worker", {
  name: "my-worker", 
  script: "console.log('Hello, world!')",
  bindings: {
    SITE: site
  }
});
```