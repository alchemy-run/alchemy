# Static Site

The Static Site component allows you to deploy static web content to [Cloudflare Workers](https://developers.cloudflare.com/workers/), using KV for asset storage. It provides an efficient way to serve static websites with global distribution and caching.

# Minimal Example

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist",
});
```

# Create the Static Site

```ts
import { StaticSite } from "alchemy/cloudflare";

const site = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist",
  build: {
    command: "npm run build",
  },
  assets: {
    fileOptions: [
      {
        files: "**/*.js",
        cacheControl: "max-age=31536000,public,immutable",
      },
    ],
  },
  domain: "www.example.com",
});
```

# Bind to a Worker

```ts
import { Worker, StaticSite } from "alchemy/cloudflare";

const mySite = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist",
  routes: {
    "/api/*": await Worker("api-worker", {
      name: "api-worker",
      script: "console.log('Hello, API!')",
    }),
  },
});
```