# WranglerJson

The WranglerJson resource generates a `wrangler.json` configuration file for a [Cloudflare Worker](https://developers.cloudflare.com/workers/configuration/wrangler-configuration/).

# Minimal Example

Creates a basic wrangler.json file for a Worker:

```ts
import { Worker, WranglerJson } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts"
});

await WranglerJson("wrangler", {
  worker
});
```

# With Custom Path

Specify a custom path for the wrangler.json file:

```ts
await WranglerJson("wrangler", {
  worker,
  path: "./config/wrangler.json"
});
```

# With Worker Bindings

Creates a wrangler.json file with KV, Durable Object and other bindings:

```ts
const kv = await KVNamespace("cache", {
  title: "cache-store"
});

const counter = new DurableObjectNamespace("counter", {
  className: "Counter"
});

const worker = await Worker("api", {
  name: "api-worker", 
  entrypoint: "./src/api.ts",
  bindings: {
    CACHE: kv,
    COUNTER: counter
  }
});

await WranglerJson("wrangler", {
  worker
});
```