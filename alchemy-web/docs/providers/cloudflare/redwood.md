# Redwood

The Redwood component lets you deploy [RedwoodJS](https://redwoodjs.com/) applications to Cloudflare Pages with automatically configured defaults.

# Minimal Example

Deploy a basic RedwoodJS application with default settings:

```ts
import { Redwood } from "alchemy/cloudflare";

const redwoodApp = await Redwood("my-redwood-app");
```

# Deploy with Database Binding

Add a D1 database binding to your RedwoodJS application:

```ts
import { Redwood, D1Database } from "alchemy/cloudflare";

const database = await D1Database("redwood-db");

const redwoodApp = await Redwood("redwood-with-db", {
  bindings: {
    DB: database
  }
});
```

# Custom Build and Environment

Deploy with custom build command and environment variables:

```ts
import { Redwood } from "alchemy/cloudflare";

const redwoodApp = await Redwood("custom-redwood", {
  command: "bun run test && RWSDK_DEPLOY=1 bun run build:production",
  bindings: {
    API_KEY: alchemy.secret("api-key-secret")
  },
  vars: {
    NODE_ENV: "production",
    APP_ENV: "staging"
  }
});
```

# Custom Paths and Compatibility

Deploy with custom paths and additional compatibility flags:

```ts
import { Redwood } from "alchemy/cloudflare";

const redwoodApp = await Redwood("redwood-custom-paths", {
  main: "custom/worker.js",
  assets: "custom/static",
  compatibilityFlags: ["nodejs_compat", "fetch_refused_to_set_cookies"]
});
```

# Bind to a Worker

Bind the RedwoodJS application to a Worker:

```ts
import { Worker, Redwood } from "alchemy/cloudflare";

const redwoodApp = await Redwood("my-redwood-app", {
  name: "my-redwood-app",
  bindings: {
    DB: database
  }
});

await Worker("my-worker", {
  name: "my-worker", 
  script: "console.log('Hello from worker!')",
  bindings: {
    REDWOOD: redwoodApp
  }
});
```