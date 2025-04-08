# Static Site

The Static Site resource lets you deploy static websites to [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/sites/), using KV for asset storage and global distribution.

# Minimal Example

Creates a basic static site with default settings.

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist"
});
```

# Create with Custom Settings

Creates a static site with custom error page, index file, and build command.

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("custom-site", {
  name: "custom-site", 
  dir: "./www",
  errorPage: "404.html",
  indexPage: "home.html",
  domain: "www.example.com",
  build: {
    command: "npm run build"
  }
});
```

# Bind to a Worker

Routes API requests to a backend worker while serving static content.

```ts
import { Worker, StaticSite } from "alchemy/cloudflare";

const backend = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts"
});

const site = await StaticSite("full-site", {
  name: "full-site",
  dir: "./dist",
  routes: {
    "/api/*": backend
  }
});
```