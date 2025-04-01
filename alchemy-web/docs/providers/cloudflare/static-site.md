# Static Site

The Static Site component allows you to deploy static web content to [Cloudflare Workers](https://developers.cloudflare.com/workers/), using KV for asset storage. It provides an efficient way to serve static websites with global distribution and caching.

# Minimal Example

```ts
import { StaticSite } from "alchemy/cloudflare";

const basicSite = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist",
});
```

# Create the Static Site

```ts
import { StaticSite } from "alchemy/cloudflare";

const customSite = await StaticSite("custom-site", {
  name: "custom-site",
  dir: "./www",
  errorPage: "404.html",
  indexPage: "home.html",
  domain: "www.example.com",
});
```

# Bind to a Worker

```ts
import { Worker, StaticSite } from "alchemy/cloudflare";

const mySite = await StaticSite("my-site", {
  name: "my-site",
  dir: "./dist",
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    mySite,
  },
});
```