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

Creates a static site with custom build command, error page, and caching settings.

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

# Bind to a Worker

Creates a static site with a backend API worker for handling dynamic requests.

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