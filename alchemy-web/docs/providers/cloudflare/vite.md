# Vite

The Vite component lets you deploy a [Vite](https://vitejs.dev/) application to Cloudflare Workers.

# Minimal Example

Deploy a basic Vite site with default settings:

```ts
import { Vite } from "alchemy/cloudflare";

const site = await Vite("my-vite-app", {
  name: "my-vite-app",
  command: "bun run build"
});
```

# With Custom Bindings

Add database and environment bindings to your Vite app:

```ts
import { Vite, D1Database } from "alchemy/cloudflare";

const db = await D1Database("my-db", {
  name: "my-db"
});

const site = await Vite("my-vite-app", {
  name: "my-vite-app",
  command: "bun run build",
  bindings: {
    DB: db,
    API_KEY: alchemy.secret(process.env.API_KEY)
  }
});
```

# With Custom Build Configuration

Customize the build process and output:

```ts
import { Vite } from "alchemy/cloudflare";

const site = await Vite("my-vite-app", {
  name: "my-vite-app",
  command: "bun run test && bun run build:production",
  main: "./custom/worker.js",
  assets: "./custom/static",
  compatibilityFlags: ["nodejs_compat"]
});
```

# Bind to a Worker

Use the Vite site as a binding in another Worker:

```ts
import { Worker, Vite } from "alchemy/cloudflare";

const site = await Vite("my-site", {
  name: "my-site",
  command: "bun run build"
});

await Worker("my-worker", {
  name: "my-worker", 
  script: "console.log('Hello, world!')",
  bindings: {
    SITE: site
  }
});
```