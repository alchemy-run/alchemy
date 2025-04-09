# StaticSite

The StaticSite resource deploys static web content to [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/sites/), using KV for asset storage and providing global distribution and caching.

# Minimal Example

Deploy a basic static site with default settings:

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist"
});
```

# Custom Build Command

Run a build command before deploying:

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site", 
  dir: "./public",
  build: {
    command: "npm run build"
  }
});
```

# Custom Error Page

Configure a custom error page and index file:

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./www",
  errorPage: "404.html",
  indexPage: "home.html"
});
```

# API Backend Integration

Add an API backend worker to handle API routes:

```ts
import { StaticSite, Worker } from "alchemy/cloudflare";

const backend = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts"
});

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist",
  routes: {
    "/api/*": backend
  }
});
```

# Bind to a Worker

Bind the static site to a worker to access its assets:

```ts
import { Worker, StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    SITE: site
  }
});
```