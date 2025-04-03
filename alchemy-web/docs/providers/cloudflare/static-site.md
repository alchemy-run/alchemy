# Static Site

The Static Site resource lets you deploy static websites to [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/sites/), using KV for asset storage and global distribution.

# Minimal Example

Deploy a basic static site with default settings:

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist"
});
```

# Create with Custom Settings

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
  },
  assets: {
    fileOptions: [
      {
        files: ["**/*.js", "**/*.css"],
        cacheControl: "max-age=31536000,immutable"
      }
    ]
  }
});
```

# Add API Routes

```ts
import { StaticSite, Worker } from "alchemy/cloudflare";

const api = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts"
});

const site = await StaticSite("full-site", {
  name: "full-site",
  dir: "./dist",
  routes: {
    "/api/*": api
  }
});
```