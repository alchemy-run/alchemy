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

# Create with Custom Build

Deploy a site with a custom build command and error page:

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site", 
  dir: "./public",
  build: {
    command: "npm run build"
  },
  errorPage: "404.html",
  indexPage: "home.html"
});
```

# Add API Routes

Deploy a static site with API routes handled by a Worker:

```ts
import { StaticSite, Worker } from "alchemy/cloudflare";

const api = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts"
});

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist",
  routes: {
    "/api/*": api
  }
});
```

# Configure Domain and Caching

Deploy with a custom domain and caching settings:

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist",
  domain: "www.example.com",
  assets: {
    fileOptions: [
      {
        files: ["**/*.js", "**/*.css"],
        cacheControl: "max-age=31536000,immutable"
      },
      {
        files: "**/*.html",
        cacheControl: "no-cache"
      }
    ]
  }
});
```