# Website

The Website resource lets you deploy a static website to [Cloudflare Pages](https://developers.cloudflare.com/pages/).

# Minimal Example

Deploy a basic static website to Cloudflare Pages.

```ts
import { Website } from "alchemy/cloudflare";

const site = await Website("my-site", {
  name: "my-site",
  command: "npm run build",
  assets: "./dist"
});
```

# With Custom Build Settings

Configure custom build command, entry point and asset directory.

```ts 
const site = await Website("my-site", {
  name: "my-site",
  command: "npm run build:prod",
  main: "./src/worker.ts",
  assets: {
    dist: "./build",
    html_handling: "single-page-application"
  }
});
```

# With Environment Variables and Bindings

Add environment variables and bind to other Cloudflare resources.

```ts
const db = await D1Database("my-db", {
  name: "my-db"
});

const site = await Website("my-site", {
  name: "my-site",
  command: "npm run build",
  assets: "./dist",
  env: {
    NODE_ENV: "production"
  },
  bindings: {
    DB: db
  }
});
```

# Bind to a Worker

The Website resource creates a Worker that can be bound to other Workers.

```ts
import { Worker, Website } from "alchemy/cloudflare";

const site = await Website("my-site", {
  name: "my-site",
  command: "npm run build",
  assets: "./dist"
});

await Worker("api", {
  name: "api",
  script: "console.log('Hello from API')",
  bindings: {
    SITE: site
  }
});
```